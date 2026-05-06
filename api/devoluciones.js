// api/devoluciones.js
// GET  /api/devoluciones            → listar todas
// POST /api/devoluciones            → crear devolución pendiente (no toca stock todavía)
// PUT  /api/devoluciones?id=XX      → confirmar recepción → restaura stock y sincroniza
// DELETE /api/devoluciones?id=XX   → eliminar

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
        .from('devoluciones')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'POST') {
      const d = req.body;
      if (!d.sku || !d.producto || !d.cantidad) {
        return res.status(400).json({ error: 'Faltan campos: sku, producto, cantidad' });
      }
      const { data, error } = await supabase.from('devoluciones').insert({
        id: 'DEV-' + Date.now(),
        venta_id: d.ventaId || null,
        sku: d.sku,
        producto: d.producto,
        cantidad: d.cantidad,
        estado: 'pendiente',
        notas: d.notas || null,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });

      const { data: dev, error: devErr } = await supabase
        .from('devoluciones')
        .select('*')
        .eq('id', id)
        .single();
      if (devErr || !dev) return res.status(404).json({ error: 'Devolución no encontrada' });
      if (dev.estado === 'recibida') return res.status(400).json({ error: 'Ya fue confirmada' });

      // Obtener producto para saber stock actual y meli_id
      const { data: producto, error: prodErr } = await supabase
        .from('productos')
        .select('stock_dep, meli_id, shopify_id')
        .eq('sku', dev.sku)
        .single();
      if (prodErr || !producto) throw new Error('Producto no encontrado: ' + dev.sku);

      const nuevoStock = producto.stock_dep + dev.cantidad;

      // Actualizar stock en DB
      await supabase.from('productos').update({
        stock_dep: nuevoStock,
        stock_meli: nuevoStock,
        stock_shopify: nuevoStock,
        updated_at: new Date().toISOString(),
      }).eq('sku', dev.sku);

      // Marcar devolución como recibida
      const { data: devActualizada, error: updErr } = await supabase
        .from('devoluciones')
        .update({ estado: 'recibida', recibida_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (updErr) throw updErr;

      // Sincronizar stock con MELI si tiene meli_id
      if (producto.meli_id) {
        try {
          const token = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ available_quantity: nuevoStock }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) console.warn('⚠️ MELI sync warning:', meliData.message);
          else console.log(`✅ Stock MELI restaurado: ${producto.meli_id} → ${nuevoStock}`);
        } catch (meliErr) {
          console.error('❌ Error sincronizando MELI:', meliErr.message);
        }
      }

      return res.json({ devolucion: devActualizada, nuevoStock });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const { error } = await supabase.from('devoluciones').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/devoluciones:', err);
    res.status(500).json({ error: err.message });
  }
};
