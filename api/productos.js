// api/productos.js
// GET  /api/productos        → listar todos
// POST /api/productos        → crear
// PUT  /api/productos?sku=XX → actualizar (sincroniza stock con MELI y Shopify si aplica)
// PATCH /api/productos?sku=XX → sólo descatalogar / reactivar (no toca nada más)
// DELETE /api/productos?sku=XX → eliminar

const { getSupabase } = require('./_supabase');
const { sincronizarStock, resumenSync } = require('./_stockSync');
const { parseMeliIds } = require('./_meliIds');
const { packsDisponibles, parseUnidadesPorVenta } = require('./_packs');
const { camposDiscontinuado, escribirConMotivo, faltaMigracionMotivo } = require('./_discontinuado');
const { todasLasPiezas, relacionesDeKit, guardarPiezas } = require('./_kits');

// Las piezas del kit sólo se tocan si el request las manda (`componentes`): guardar un producto
// común desde el formulario no tiene que borrar nada. Vacío = deja de ser kit.
async function guardarPiezasSiVienen(supabase, sku, p) {
  if (p.componentes === undefined) return undefined;
  return guardarPiezas(supabase, sku, p.componentes);
}

// El número que Gesta le dio al producto (lo que pide el Excel de ventas). Vacío = no está en
// Gesta. Sólo se escribe si el request lo manda, para no borrarlo desde otros guardados.
function campoCodigoGesta(p) {
  if (p.codigoGesta === undefined) return {};
  const n = parseInt(p.codigoGesta, 10);
  return { codigo_gesta: Number.isInteger(n) && n > 0 ? n : null };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('productos')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Los kits vienen con sus piezas; el resto, con la lista vacía. Sin la migración de
      // kits todos vienen vacíos.
      const piezas = await todasLasPiezas(supabase);
      return res.json((data || []).map(p => ({ ...p, componentes: piezas[p.sku] || [] })));
    }

    if (req.method === 'POST') {
      const p = req.body;
      // stock_dep va en unidades sueltas del depósito; lo publicado son packs.
      const unidadesPorVenta = parseUnidadesPorVenta(p.unidadesPorVenta);
      const packs = packsDisponibles(p.stockDep || 0, { unidades_por_venta: unidadesPorVenta });
      const { data, error, migracionMotivoPendiente } = await escribirConMotivo(
        fila => supabase.from('productos').insert(fila).select().single(),
        {
          sku: p.sku, nombre: p.nombre,
          grupo: p.grupo?.trim() || null,
          subgrupo: p.subgrupo?.trim() || null,
          tipo: p.tipo || 'nuevo',
          unidades_por_venta: unidadesPorVenta,
          stock_dep: p.stockDep || 0,
          // El espejo siempre sale del depósito, nunca de lo que mande el cliente:
          // las tres columnas tienen que nacer iguales.
          stock_meli: packs,
          stock_shopify: packs,
          costo: p.costo || 0, precio: p.precio,
          alerta_min: p.alertaMin || 5,
          // meli_id lo deriva el trigger a partir de meli_ids[1].
          meli_ids: parseMeliIds(p.meliIds !== undefined ? p.meliIds : p.meliId),
          shopify_id: p.shopifyId || null,
          notas: p.notas,
          ...campoCodigoGesta(p),
        },
        camposDiscontinuado(p, null),
      );
      if (error) throw error;

      // Un kit nuevo: al cargar las piezas la base le calcula el stock, y se publica con ese.
      const componentes = await guardarPiezasSiVienen(supabase, data.sku, p);
      if (componentes?.length) {
        const { data: kit } = await supabase.from('productos').select('*').eq('sku', data.sku).single();
        const sync = await sincronizarStock(supabase, kit || data, (kit || data).stock_dep);
        console.log('🧩 Kit nuevo:', resumenSync(data.sku, sync));
        return res.json({ ...(kit || data), componentes, sync, ...(migracionMotivoPendiente ? { migracionMotivoPendiente } : {}) });
      }
      return res.json(migracionMotivoPendiente ? { ...data, migracionMotivoPendiente } : data);
    }

    if (req.method === 'PUT') {
      const sku = req.query.sku;
      const p = req.body;

      // Obtener producto anterior para comparar stock y para no pisar lo que el request no
      // manda (el motivo del descatalogado, entre otras cosas). Si la migración del motivo
      // todavía no corrió, el select con esas columnas falla, así que se reintenta con las
      // de siempre en vez de quedarse sin fila anterior.
      const COLS_BASE = 'stock_dep, stock_meli, stock_shopify, unidades_por_venta, meli_id, meli_ids, shopify_id, discontinuado';
      let { data: anterior, error: antErr } = await supabase
        .from('productos')
        .select(`${COLS_BASE}, motivo_discontinuado, nota_discontinuado, fecha_discontinuado`)
        .eq('sku', sku)
        .single();
      if (antErr && faltaMigracionMotivo(antErr)) {
        ({ data: anterior } = await supabase.from('productos').select(COLS_BASE).eq('sku', sku).single());
      }

      // Un kit no tiene depósito propio: su stock lo calcula la base con las piezas, así que
      // lo que mande el formulario se ignora (la base lo pisaría igual). Si se lo tomara como
      // un ajuste, cambiar el número del kit movería el stock de las piezas sin querer.
      const esKit = (await relacionesDeKit(supabase, sku)).piezas.length > 0 || !!p.componentes?.length;

      // stock_dep es la fuente de verdad, en unidades sueltas del depósito.
      // Lo que se publica (y lo que espejan stock_meli/stock_shopify) son los
      // packs completos que salen de ese stock.
      const stockCanon = esKit ? (anterior?.stock_dep ?? 0) : p.stockDep;
      const unidadesPorVenta = parseUnidadesPorVenta(
        p.unidadesPorVenta !== undefined ? p.unidadesPorVenta : anterior?.unidades_por_venta
      );
      const stockPublicado = packsDisponibles(stockCanon, { unidades_por_venta: unidadesPorVenta });

      const { data, error, migracionMotivoPendiente } = await escribirConMotivo(
        fila => supabase.from('productos').update(fila).eq('sku', sku).select().single(),
        {
          sku: p.sku,  // permite cambiar el SKU
          nombre: p.nombre,
          grupo: p.grupo?.trim() || null,
          subgrupo: p.subgrupo?.trim() || null,
          tipo: p.tipo || 'nuevo',
          unidades_por_venta: unidadesPorVenta,
          stock_dep: stockCanon,
          stock_meli: stockPublicado,
          stock_shopify: stockPublicado,
          costo: p.costo, precio: p.precio,
          alerta_min: p.alertaMin,
          // meli_id lo deriva el trigger a partir de meli_ids[1].
          meli_ids: parseMeliIds(p.meliIds !== undefined ? p.meliIds : p.meliId),
          shopify_id: p.shopifyId || null,
          notas: p.notas,
          ...campoCodigoGesta(p),
        },
        // Guardar un producto desde el formulario de edición no manda `discontinuado`, y
        // antes eso lo reactivaba en silencio: el formulario no pregunta por el campo, así
        // que un editar-y-guardar devolvía a reposición un producto ya descatalogado.
        // camposDiscontinuado conserva lo que había cuando el request no lo pisa.
        camposDiscontinuado(p, anterior),
      );
      if (error) throw error;

      // Piezas del kit (si vinieron). Cambiarlas cambia el stock del kit: se relee y se publica.
      const componentes = await guardarPiezasSiVienen(supabase, data.sku, p);
      if (esKit || componentes?.length) {
        const { data: kit } = await supabase.from('productos').select('*').eq('sku', data.sku).single();
        const fila = kit || data;
        const sync = await sincronizarStock(supabase, fila, fila.stock_dep);
        console.log('🧩 Kit:', resumenSync(fila.sku, sync));
        return res.json({ ...fila, componentes: componentes ?? undefined, sync, ...(migracionMotivoPendiente ? { migracionMotivoPendiente } : {}) });
      }

      const forzarSync = p.forzarSync === true;
      // Cambiar las unidades por venta mueve lo publicado aunque el depósito
      // no se toque (16 sueltas pasan de 16 publicadas a 8 pares).
      const stockCambio = !anterior
        || anterior.stock_dep !== stockCanon
        || (anterior.unidades_por_venta ?? 1) !== unidadesPorVenta;

      // Se sincroniza si cambió el stock, si se sumó alguna publicación nueva
      // o si se forzó. `data` ya trae meli_ids normalizado por el trigger.
      const idsAntes = new Set(parseMeliIds(anterior?.meli_ids ?? anterior?.meli_id));
      const hayPublicacionNueva = parseMeliIds(data.meli_ids).some((id) => !idsAntes.has(id));

      // Se republica si cambió el stock, si se sumó una publicación nueva o si
      // se forzó. sincronizarStock vuelve a escribir stock_dep con el mismo
      // valor que ya guardó el update de arriba: es idempotente y deja las tres
      // columnas y los dos canales en el mismo número.
      if (forzarSync || stockCambio || hayPublicacionNueva) {
        const sync = await sincronizarStock(supabase, data, stockCanon);
        console.log('✏️ Ajuste manual:', resumenSync(data.sku, sync));
        return res.json({ ...data, sync, ...(migracionMotivoPendiente ? { migracionMotivoPendiente } : {}) });
      }

      return res.json(migracionMotivoPendiente ? { ...data, migracionMotivoPendiente } : data);
    }

    // Sólo el descatalogado: { discontinuado, motivoDiscontinuado, notaDiscontinuado,
    // fechaDiscontinuado }. Lo usa 📅 Reposición para descatalogar sin tener el producto
    // entero: el PUT reescribe la fila completa (un campo que no viene lo vacía), así que
    // mandarle sólo el descatalogado le borraría las publicaciones y el grupo. Acá no se
    // toca nada más y no se sincroniza stock: descatalogar no cambia lo que hay.
    if (req.method === 'PATCH') {
      const sku = req.query.sku;
      const p = req.body || {};
      if (!sku) return res.status(400).json({ error: 'Falta el sku' });
      if (p.discontinuado === undefined) return res.status(400).json({ error: 'Falta discontinuado' });

      const COLS = 'sku, discontinuado';
      let { data: anterior, error: antErr } = await supabase
        .from('productos')
        .select(`${COLS}, motivo_discontinuado, nota_discontinuado, fecha_discontinuado`)
        .eq('sku', sku)
        .maybeSingle();
      if (antErr && faltaMigracionMotivo(antErr)) {
        ({ data: anterior, error: antErr } = await supabase.from('productos').select(COLS).eq('sku', sku).maybeSingle());
      }
      if (antErr) throw antErr;
      if (!anterior) return res.status(404).json({ error: `No existe el producto ${sku}` });

      const { data, error, migracionMotivoPendiente } = await escribirConMotivo(
        fila => supabase.from('productos').update(fila).eq('sku', sku).select().single(),
        {},
        camposDiscontinuado(p, anterior),
      );
      if (error) throw error;
      return res.json(migracionMotivoPendiente ? { ...data, migracionMotivoPendiente } : data);
    }

    if (req.method === 'DELETE') {
      const sku = req.query.sku;
      const { error } = await supabase.from('productos').delete().eq('sku', sku);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/productos:', err);
    res.status(500).json({ error: err.message });
  }
};
