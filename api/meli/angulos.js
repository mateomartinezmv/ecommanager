// api/meli/angulos.js
// GET  /api/meli/angulos                       → cuántos ángulos de venta tiene cada producto
// POST /api/meli/angulos { sku, cantidad }     → PROPONE ángulos nuevos (no publica nada)
// POST /api/meli/angulos { sku, publicar:[…] } → publica los ángulos aprobados
//
// Un producto con una sola publicación sólo aparece en las búsquedas que pegan con ese
// título. La idea es que cada producto tenga al menos ANGULOS_OBJETIVO publicaciones activas,
// cada una apuntando a otra forma de buscarlo. La publicación original nunca se toca ni se
// baja: las nuevas se suman.
//
// Proponer y publicar están separados a propósito. Publicar crea avisos públicos reales en la
// cuenta del vendedor, así que el endpoint nunca lo hace solo: primero devuelve los títulos
// propuestos y recién publica lo que vuelve aprobado desde la pantalla.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe, parseMeliIds } = require('../_meliIds');
const {
  ANGULOS_OBJETIVO,
  meliGet,
  obtenerItem,
  obtenerDescripcion,
  maxTitulo,
  motivoNoClonable,
  detectarModoTitulo,
  sufijoTitulo,
  tituloFinal,
  validarAngulo,
  crearPublicacion,
  ponerDescripcion,
  limpiarTitulo,
  limpiarDescripcion,
} = require('../_meliPublicaciones');
const { redactarAngulos } = require('../_angulosIA');

const LOTE = 20;               // multiget de MELI
const MAX_POR_PUBLICADA = 5;   // tope de publicaciones nuevas por request

const ERROR_TABLA = 'Falta la tabla meli_angulos. Corré la migración supabase/migrations/20260915010000_add_meli_angulos.sql en el SQL Editor de Supabase.';

function faltaTabla(error) {
  return !!error && (error.code === '42P01' || /meli_angulos/.test(error.message || '') && /does not exist|no existe/i.test(error.message || ''));
}

// Estado de todas las publicaciones que el CRM tiene enlazadas, en un solo mapa.
async function estadoDePublicaciones(token, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const mapa = {};
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    try {
      const data = await meliGet(
        token,
        `/items?ids=${lote.join(',')}&attributes=id,title,status,permalink,sold_quantity,catalog_listing`
      );
      for (const entrada of data || []) {
        if (entrada.code === 200 && entrada.body?.id) {
          const it = entrada.body;
          mapa[it.id] = {
            meli_id: it.id,
            titulo: it.title || null,
            estado: it.status || null,
            permalink: it.permalink || null,
            vendidos: Number(it.sold_quantity) || 0,
            catalogo: !!it.catalog_listing,
          };
        }
      }
    } catch (e) {
      console.error('estadoDePublicaciones:', e.message);
    }
  }
  return mapa;
}

// La publicación que se usa de molde: la que más vendió entre las activas. Es la que mejor
// refleja cómo está cargado el producto (fotos, ficha, garantía).
function elegirOrigen(publicaciones) {
  const activas = publicaciones.filter(p => p.estado === 'active' && !p.catalogo);
  if (!activas.length) return null;
  return activas.slice().sort((a, b) => b.vendidos - a.vendidos)[0];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    let token;
    try {
      token = await getMeliToken();
    } catch {
      return res.json({ ok: false, error: 'MELI no está conectado. Autorizá la app primero.', objetivo: ANGULOS_OBJETIVO, productos: [] });
    }

    // ── Cobertura de ángulos por producto ───────────────────────
    if (req.method === 'GET') {
      const { data: productos, error } = await supabase
        .from('productos')
        .select('sku, nombre, stock_dep, precio, meli_id, meli_ids, discontinuado')
        .order('nombre');
      if (error) throw error;

      const vivos = (productos || []).filter(p => !p.discontinuado);
      const mapa = await estadoDePublicaciones(token, vivos.flatMap(meliIdsDe));

      // Lo que ya publicó esta pantalla, para poder mostrar el historial.
      let creadas = [];
      const { data: filas, error: errAng } = await supabase
        .from('meli_angulos')
        .select('*')
        .order('created_at', { ascending: false });
      if (errAng && !faltaTabla(errAng)) throw errAng;
      creadas = filas || [];

      const salida = vivos.map(p => {
        const publicaciones = meliIdsDe(p).map(id => mapa[id] || { meli_id: id, titulo: null, estado: 'desconocida', permalink: null, vendidos: 0, catalogo: false });
        const activas = publicaciones.filter(x => x.estado === 'active');
        return {
          sku: p.sku,
          nombre: p.nombre,
          stock: p.stock_dep || 0,
          precio: p.precio || 0,
          publicaciones,
          activas: activas.length,
          faltan: Math.max(0, ANGULOS_OBJETIVO - activas.length),
          origen: elegirOrigen(publicaciones),
          creadas: creadas.filter(c => c.sku === p.sku).length,
        };
      });

      return res.json({
        ok: true,
        objetivo: ANGULOS_OBJETIVO,
        productos: salida,
        historial: creadas.slice(0, 50),
        sin_tabla: !!(errAng && faltaTabla(errAng)),
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const sku = String(req.body?.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'Falta sku' });

    const { data: producto, error: errProd } = await supabase
      .from('productos')
      .select('sku, nombre, stock_dep, meli_id, meli_ids')
      .eq('sku', sku)
      .single();
    if (errProd || !producto) return res.status(404).json({ ok: false, error: `No existe el producto ${sku} en el CRM.` });

    const ids = meliIdsDe(producto);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: `${sku} no tiene ninguna publicación de MELI enlazada: no hay de dónde copiar.` });
    }

    const mapa = await estadoDePublicaciones(token, ids);
    const publicaciones = ids.map(id => mapa[id]).filter(Boolean);
    const origen = elegirOrigen(publicaciones);
    if (!origen) {
      return res.status(400).json({ ok: false, error: `${sku} no tiene publicaciones activas clonables (las de catálogo no se pueden duplicar).` });
    }

    const item = await obtenerItem(token, origen.meli_id);
    const motivo = motivoNoClonable(item);
    if (motivo) return res.status(400).json({ ok: false, error: motivo, origen });

    // El largo máximo del título lo fija la categoría: pasarse es error de publicación.
    const max = await maxTitulo(token, item.category_id);

    // Cuentas en User Products mandan family_name y MELI arma el título visible pegándole
    // los atributos de la variante. El sufijo sale del original: título menos family_name.
    let usuario = null;
    try { usuario = await meliGet(token, '/users/me'); } catch { /* alcanza con el ítem */ }
    const modoTitulo = detectarModoTitulo(item, usuario);
    const sufijo = sufijoTitulo(item);

    // ── Publicar lo aprobado ────────────────────────────────────
    if (Array.isArray(req.body?.publicar)) {
      const pedidos = req.body.publicar
        .map(a => ({
          angulo: String(a?.angulo || '').trim() || 'Ángulo alternativo',
          titulo: limpiarTitulo(a?.titulo, max),
          descripcion: limpiarDescripcion(a?.descripcion),
        }))
        .filter(a => a.titulo)
        .slice(0, MAX_POR_PUBLICADA);

      if (!pedidos.length) return res.status(400).json({ ok: false, error: 'No llegó ningún título para publicar.' });

      const stock = Math.max(0, Number(producto.stock_dep) || 0);
      const resultados = [];
      let giro = publicaciones.length; // arranca donde quedó la última, para no repetir miniatura

      for (const pedido of pedidos) {
        giro += 1;
        try {
          const nueva = await crearPublicacion(token, item, {
            titulo: pedido.titulo,
            sku: producto.sku,
            stock,
            giroFotos: giro,
            modoTitulo,
          });

          // En User Products dos ítems del mismo user_product comparten título y stock: si
          // la nueva cayó en el mismo UP que la original, no es un ángulo aparte y además
          // MELI puede espejar el título. Hay que avisarlo, no dejarlo pasar.
          const mismoUP = !!(nueva.user_product_id && item.user_product_id && nueva.user_product_id === item.user_product_id);
          const avisoUP = [
            mismoUP ? 'MELI la agrupó en el mismo producto de usuario que la original: comparten título y stock. Revisala y pausala si no quedó como un ángulo aparte.' : null,
            ...(nueva.avisos_ajustes || []),
          ].filter(Boolean).join(' · ') || null;

          // La descripción va aparte y no puede tumbar una publicación que ya se creó.
          let avisoDescripcion = avisoUP;
          try {
            await ponerDescripcion(token, nueva.id, pedido.descripcion);
          } catch (e) {
            avisoDescripcion = `${avisoDescripcion ? avisoDescripcion + ' · ' : ''}La publicación se creó pero la descripción no: ${e.message}`;
          }

          // Enlazar en el CRM: sin esto la publicación nueva no recibe stock ni registra ventas.
          const { data: actual } = await supabase
            .from('productos').select('meli_ids, meli_id').eq('sku', producto.sku).single();
          const idsActuales = parseMeliIds(actual?.meli_ids ?? actual?.meli_id);
          if (!idsActuales.includes(nueva.id)) {
            const { error: errLink } = await supabase
              .from('productos')
              .update({ meli_ids: [...idsActuales, nueva.id] })
              .eq('sku', producto.sku);
            if (errLink) avisoDescripcion = `${avisoDescripcion ? avisoDescripcion + ' · ' : ''}No se pudo enlazar al SKU en el CRM: ${errLink.message}`;
          }

          const fila = {
            sku: producto.sku,
            origen_meli_id: origen.meli_id,
            nuevo_meli_id: nueva.id,
            angulo: pedido.angulo,
            titulo: pedido.titulo,
            // El título que quedó publicado lo decide MELI en el modelo nuevo: se guarda el
            // que devolvió, no el que mandamos.
            titulo_final: nueva.title || tituloFinal(pedido.titulo, sufijo),
            user_product_id: nueva.user_product_id || null,
            permalink: nueva.permalink || null,
            estado: 'publicada',
            error: avisoDescripcion,
          };
          const { error: errIns } = await supabase.from('meli_angulos').insert(fila);
          if (errIns && !faltaTabla(errIns)) console.error('meli_angulos insert:', errIns.message);

          resultados.push({ ok: true, ...fila, estado_meli: nueva.status || null });
        } catch (e) {
          const fila = {
            sku: producto.sku,
            origen_meli_id: origen.meli_id,
            nuevo_meli_id: null,
            angulo: pedido.angulo,
            titulo: pedido.titulo,
            permalink: null,
            estado: 'error',
            error: e.message,
          };
          const { error: errIns } = await supabase.from('meli_angulos').insert(fila);
          if (errIns && !faltaTabla(errIns)) console.error('meli_angulos insert:', errIns.message);
          resultados.push({ ok: false, ...fila });
        }
      }

      return res.json({
        ok: true,
        sku: producto.sku,
        publicadas: resultados.filter(r => r.ok).length,
        fallidas: resultados.filter(r => !r.ok).length,
        resultados,
      });
    }

    // ── Proponer ángulos (no publica) ───────────────────────────
    const activas = publicaciones.filter(p => p.estado === 'active').length;
    const cantidad = Math.min(
      MAX_POR_PUBLICADA,
      Math.max(1, Number(req.body?.cantidad) || Math.max(1, ANGULOS_OBJETIVO - activas))
    );

    const descripcion = await obtenerDescripcion(token, origen.meli_id);
    const stock = Math.max(0, Number(producto.stock_dep) || 0);

    let angulos = [];
    let iaError = null;
    try {
      angulos = await redactarAngulos({
        tituloOriginal: item.title,
        otrosTitulos: publicaciones.filter(p => p.meli_id !== origen.meli_id && p.titulo).map(p => p.titulo),
        categoria: item.domain_id || item.category_id,
        atributos: item.attributes,
        descripcion,
        producto: { sku: producto.sku, nombre: producto.nombre },
        cantidad,
        maxTitulo: max,
        modoTitulo,
        sufijo,
      });
    } catch (e) {
      iaError = e.message;
    }

    // Validar cada propuesta contra MELI antes de mostrarla: mejor enterarse acá que
    // después de apretar publicar.
    const propuestas = [];
    for (let i = 0; i < angulos.length; i++) {
      const a = angulos[i];
      const titulo = limpiarTitulo(a.titulo, max);
      const validacion = await validarAngulo(token, item, {
        titulo,
        sku: producto.sku,
        stock,
        giroFotos: publicaciones.length + i + 1,
        modoTitulo,
      });
      propuestas.push({
        angulo: a.angulo,
        titulo,
        titulo_final: tituloFinal(titulo, sufijo),
        descripcion: limpiarDescripcion(a.descripcion),
        valida: validacion.valida,
        errores: validacion.errores,
        aviso: [validacion.aviso, ...(validacion.avisos_ajustes || [])].filter(Boolean).join(' · ') || null,
      });
    }

    return res.json({
      ok: true,
      sku: producto.sku,
      nombre: producto.nombre,
      stock,
      objetivo: ANGULOS_OBJETIVO,
      activas,
      max_titulo: max,
      modo_titulo: modoTitulo,
      sufijo_titulo: sufijo,
      origen: { ...origen, precio: item.price, moneda: item.currency_id, fotos: (item.pictures || []).length, family_name: item.family_name || null },
      angulos: propuestas,
      ia_error: iaError,
      aviso_stock: stock === 0 ? 'El producto está en 0: MELI va a crear las publicaciones pausadas por falta de stock.' : null,
    });
  } catch (err) {
    console.error('Error en /api/meli/angulos:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
