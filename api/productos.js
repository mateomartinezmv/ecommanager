// api/productos.js
// GET  /api/productos        → listar todos
// POST /api/productos        → crear
// PUT  /api/productos?sku=XX → actualizar (sincroniza stock con MELI y Shopify si aplica)
// DELETE /api/productos?sku=XX → eliminar

const { getSupabase } = require('./_supabase');
const { getMeliToken } = require('./_meliToken');
const { getShopifyToken } = require('./_shopifyToken');
const { syncMeliStock, syncShopifyStock } = require('./_stockSync');

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
      const { data, error } = await supabase.from('productos').insert({
        sku: p.sku, nombre: p.nombre, categoria: p.categoria,
        tipo: p.tipo || 'nuevo',
        stock_dep: p.stockDep || 0,
        stock_meli: p.stockMeli || 0,
        stock_shopify: p.stockShopify || 0,
        costo: p.costo || 0, precio: p.precio,
        alerta_min: p.alertaMin || 5,
        meli_id: p.meliId || null,
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
        .select('stock_dep, stock_meli, stock_shopify, meli_id, shopify_id')
        .eq('sku', sku)
        .single();

      // stock_dep es la fuente de verdad — stock_meli y stock_shopify siempre lo siguen
      const stockCanon = p.stockDep;

      const { data, error } = await supabase.from('productos').update({
        sku: p.sku,  // permite cambiar el SKU
        nombre: p.nombre, categoria: p.categoria,
        tipo: p.tipo || 'nuevo',
        stock_dep: stockCanon,
        stock_meli: stockCanon,
        stock_shopify: stockCanon,
        costo: p.costo, precio: p.precio,
        alerta_min: p.alertaMin,
        meli_id: p.meliId || null,
        shopify_id: p.shopifyId || null,
        notas: p.notas,
        discontinuado: p.discontinuado !== undefined ? p.discontinuado : false,
      }).eq('sku', sku).select().single();
      if (error) throw error;

      const meliId = p.meliId || anterior?.meli_id;
      const shopifyId = p.shopifyId || anterior?.shopify_id;
      const forzarSync = p.forzarSync === true;
      const stockCambio = !anterior || anterior.stock_dep !== stockCanon;

      // Sincronizar stock MELI si stock_dep cambió, si se enlazó un meli_id nuevo, o se forzó
      if (meliId && (forzarSync || stockCambio || (!anterior?.meli_id && meliId))) {
        try {
          const token = await getMeliToken();
          await syncMeliStock(token, meliId, stockCanon);
          console.log(`✅ Stock MELI sincronizado: ${meliId} → ${stockCanon}`);
        } catch (meliErr) {
          console.error('❌ Error sincronizando stock MELI:', meliErr.message);
        }
      }

      // Sincronizar stock Shopify si stock_dep cambió, si se enlazó un shopify_id nuevo, o se forzó
      if (shopifyId && (forzarSync || stockCambio || (!anterior?.shopify_id && shopifyId))) {
        try {
          const token = await getShopifyToken();
          await syncShopifyStock(token, shopifyId, stockCanon);
          console.log(`✅ Stock Shopify sincronizado: variant ${shopifyId} → ${stockCanon}`);
        } catch (shopErr) {
          console.error('❌ Error sincronizando stock Shopify:', shopErr.message);
        }
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
