// api/productos.js
// GET  /api/productos        → listar todos
// POST /api/productos        → crear
// PUT  /api/productos?sku=XX → actualizar (sincroniza stock con MELI y Shopify si aplica)
// DELETE /api/productos?sku=XX → eliminar

const { getSupabase } = require('./_supabase');
const { sincronizarStock, resumenSync } = require('./_stockSync');
const { parseMeliIds } = require('./_meliIds');
const { packsDisponibles, parseUnidadesPorVenta } = require('./_packs');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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
      return res.json(data);
    }

    if (req.method === 'POST') {
      const p = req.body;
      // stock_dep va en unidades sueltas del depósito; lo publicado son packs.
      const unidadesPorVenta = parseUnidadesPorVenta(p.unidadesPorVenta);
      const packs = packsDisponibles(p.stockDep || 0, { unidades_por_venta: unidadesPorVenta });
      const { data, error } = await supabase.from('productos').insert({
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
        discontinuado: p.discontinuado || false,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const sku = req.query.sku;
      const p = req.body;

      // Obtener producto anterior para comparar stock
      const { data: anterior } = await supabase
        .from('productos')
        .select('stock_dep, stock_meli, stock_shopify, unidades_por_venta, meli_id, meli_ids, shopify_id')
        .eq('sku', sku)
        .single();

      // stock_dep es la fuente de verdad, en unidades sueltas del depósito.
      // Lo que se publica (y lo que espejan stock_meli/stock_shopify) son los
      // packs completos que salen de ese stock.
      const stockCanon = p.stockDep;
      const unidadesPorVenta = parseUnidadesPorVenta(
        p.unidadesPorVenta !== undefined ? p.unidadesPorVenta : anterior?.unidades_por_venta
      );
      const stockPublicado = packsDisponibles(stockCanon, { unidades_por_venta: unidadesPorVenta });

      const { data, error } = await supabase.from('productos').update({
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
        discontinuado: p.discontinuado !== undefined ? p.discontinuado : false,
      }).eq('sku', sku).select().single();
      if (error) throw error;

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
        return res.json({ ...data, sync });
      }

      return res.json(data);
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
