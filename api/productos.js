// api/productos.js
// GET  /api/productos        → listar todos
// POST /api/productos        → crear
// PUT  /api/productos?sku=XX → actualizar (sincroniza stock con MELI si tiene meli_id)
// DELETE /api/productos?sku=XX → eliminar

const { getSupabase } = require('./_supabase');
const { getMeliToken } = require('./_meliToken');

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
        stock_dep: p.stockDep || 0, stock_meli: p.stockMeli || 0,
        costo: p.costo || 0, precio: p.precio,
        alerta_min: p.alertaMin || 5, meli_id: p.meliId, notas: p.notas,
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
        .select('stock_meli, meli_id')
        .eq('sku', sku)
        .single();

      const { data, error } = await supabase.from('productos').update({
        nombre: p.nombre, categoria: p.categoria,
        stock_dep: p.stockDep, stock_meli: p.stockMeli,
        costo: p.costo, precio: p.precio,
        alerta_min: p.alertaMin, meli_id: p.meliId, notas: p.notas,
      }).eq('sku', sku).select().single();
      if (error) throw error;

      // Si tiene meli_id y el stock_meli cambió → actualizar en MELI
      const meliId = p.meliId || anterior?.meli_id;
      const stockMeliCambio = anterior && anterior.stock_meli !== p.stockMeli;

      if (meliId && stockMeliCambio) {
        try {
          const token = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${meliId}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ available_quantity: p.stockMeli }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) console.warn('⚠️ MELI stock sync warning:', meliData.message);
          else console.log(`✅ Stock MELI sincronizado: ${meliId} → ${p.stockMeli}`);
        } catch (meliErr) {
          console.error('❌ Error sincronizando stock MELI:', meliErr.message);
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
