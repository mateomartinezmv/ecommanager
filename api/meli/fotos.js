// api/meli/fotos.js
// GET  /api/meli/fotos                      → compara las fotos de cada publicación contra la original
// POST /api/meli/fotos { sku }              → copia las fotos de la original, en su orden, a sus ángulos
// POST /api/meli/fotos                      → lo mismo en todos los productos que estén distintos
// POST /api/meli/fotos { sku, destinos:[…] } → sólo a esas publicaciones
//
// Los ángulos nacen con las fotos de la original, pero ahí se despegan: una foto nueva, una
// que se saca porque ya no es el producto que llega, un orden distinto para cambiar la
// miniatura. Todo eso se hace en la original y los ángulos se quedan con lo viejo. El
// comprador que entra por un ángulo termina viendo otro producto que el que entra por la
// original, y la foto equivocada se paga en reclamos.
//
// Las fotos se mandan por id: ya están subidas en la cuenta, así que MELI las reusa tal cual
// en vez de volver a descargarlas. Si rechaza algún id se reintenta con la url.
//
// Lo que no se toca: las publicaciones de catálogo (las fotos son de la ficha de MELI, no del
// vendedor) y las que no están activas ni pausadas (MELI no deja editarlas).

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet, meliFetch, mensajeDeError } = require('../_meliPublicaciones');
const { fotosDe, mismasFotos, compararProductos, cuerpoPictures } = require('./_fotos');

const LOTE = 20;        // multiget de MELI
// La función se corta a los 60s (vercel.json). Cada publicación es un PUT, así que una
// pasada sobre todo el catálogo no entra: se copia lo que entre y se avisa cuántas quedaron
// para la próxima, en vez de morir a mitad de camino sin decir qué llegó a hacerse.
const TOPE_MS = 50000;

// Cada publicación con sus fotos, en el orden en que las muestra.
async function traerPublicaciones(token, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const mapa = {};
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    try {
      const data = await meliGet(
        token,
        `/items?ids=${lote.join(',')}&attributes=id,title,status,permalink,catalog_listing,pictures`
      );
      for (const entrada of data || []) {
        if (entrada.code === 200 && entrada.body?.id) {
          const it = entrada.body;
          mapa[it.id] = {
            meli_id: it.id,
            titulo: it.title || null,
            estado: it.status || null,
            permalink: it.permalink || null,
            catalogo: !!it.catalog_listing,
            fotos: fotosDe(it),
          };
        }
      }
    } catch (e) {
      console.error('traerPublicaciones:', e.message);
    }
  }
  return mapa;
}

async function auditar(token, supabase, skuFiltro = '') {
  const { data: productos, error } = await supabase
    .from('productos')
    .select('sku, nombre, meli_id, meli_ids, discontinuado')
    .order('nombre');
  if (error) throw error;

  // Un producto con una sola publicación no tiene con qué compararse; uno descatalogado ya
  // no se mantiene.
  const vivos = (productos || [])
    .filter(p => !p.discontinuado && meliIdsDe(p).length > 1)
    .filter(p => !skuFiltro || p.sku === skuFiltro);

  const mapa = await traerPublicaciones(token, vivos.flatMap(meliIdsDe));
  return compararProductos(
    vivos.map(p => ({ sku: p.sku, nombre: p.nombre, ids: meliIdsDe(p) })),
    mapa
  );
}

// Copia las fotos de la original a sus ángulos. No corta ante un fallo: una publicación que
// MELI no deja tocar no puede dejar a las demás con las fotos viejas.
async function copiar(token, fila, destinos = null) {
  const resultados = [];

  for (const pub of fila.publicaciones) {
    if (!pub.copiable) continue;
    if (destinos && !destinos.has(pub.meli_id)) continue;

    const anotar = (extra) => resultados.push({
      sku: fila.sku,
      meli_id: pub.meli_id,
      titulo: pub.titulo,
      antes: pub.fotos.length,
      ...extra,
    });

    // Primero por id, que es reusar la misma foto; si MELI lo rechaza, por url.
    let r = await meliFetch(token, `/items/${pub.meli_id}`, {
      method: 'PUT',
      body: JSON.stringify(cuerpoPictures(fila.original.fotos, 'id')),
    });
    let modo = 'id';
    if (!r.ok) {
      r = await meliFetch(token, `/items/${pub.meli_id}`, {
        method: 'PUT',
        body: JSON.stringify(cuerpoPictures(fila.original.fotos, 'source')),
      });
      modo = 'source';
    }

    if (!r.ok) {
      anotar({ ok: false, error: mensajeDeError(r.data, r.status) });
      continue;
    }

    // Lo que quedó publicado lo dice MELI, no lo que mandamos: puede haber descartado una
    // foto repetida o no haber podido con alguna.
    const quedaron = fotosDe(r.data);
    anotar({
      ok: true,
      ahora: quedaron.length,
      modo,
      aviso: mismasFotos(fila.original.fotos, quedaron)
        ? null
        : `MELI dejó ${quedaron.length} de las ${fila.original.fotos.length} fotos de la original, o en otro orden. Revisá la publicación.`,
    });
  }

  return resultados;
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
      return res.json({ ok: false, error: 'MELI no está conectado. Autorizá la app primero.', productos: [] });
    }

    // ── Foto de cómo está cada publicación ──────────────────────
    if (req.method === 'GET') {
      const filas = await auditar(token, supabase);
      const distintas = filas.reduce((s, f) => s + f.distintas, 0);
      return res.json({
        ok: true,
        productos: filas,
        resumen: {
          productos: filas.length,
          publicaciones: filas.reduce((s, f) => s + f.total, 0),
          distintas,
          copiables: filas.reduce((s, f) => s + f.copiables, 0),
          trabadas: filas.reduce((s, f) => s + f.trabadas, 0),
          productos_afectados: filas.filter(f => f.distintas > 0).length,
        },
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    // ── Copiar las fotos de la original a sus ángulos ───────────
    const skuFiltro = String(req.body?.sku || '').trim();
    const filas = await auditar(token, supabase, skuFiltro);
    if (skuFiltro && !filas.length) {
      return res.status(404).json({
        ok: false,
        error: `${skuFiltro} no tiene más de una publicación enlazada con fotos para comparar.`,
      });
    }

    const destinos = Array.isArray(req.body?.destinos) && req.body.destinos.length
      ? new Set(req.body.destinos.map(String))
      : null;

    const inicio = Date.now();
    const resultados = [];
    let pendientes = 0;
    for (const fila of filas) {
      const aCopiar = fila.publicaciones.filter(p => p.copiable && (!destinos || destinos.has(p.meli_id))).length;
      if (!aCopiar) continue;
      if (Date.now() - inicio > TOPE_MS) { pendientes += aCopiar; continue; }
      resultados.push(...await copiar(token, fila, destinos));
    }

    return res.json({
      ok: true,
      copiadas: resultados.filter(r => r.ok).length,
      fallidas: resultados.filter(r => !r.ok).length,
      pendientes,
      resultados,
    });
  } catch (err) {
    console.error('Error en /api/meli/fotos:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
