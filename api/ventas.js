// api/ventas.js
// GET    /api/ventas       → listar
// POST   /api/ventas       → crear (descuenta stock y actualiza MELI si aplica)
// PUT    /api/ventas?id=XX → editar venta existente
// DELETE /api/ventas?id=XX → eliminar

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
        .from('ventas')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'POST') {
      const v = req.body;

      const { data: producto, error: prodErr } = await supabase
        .from('productos')
        .select('*')
        .eq('sku', v.sku)
        .single();
      if (prodErr || !producto) throw new Error('Producto no encontrado: ' + v.sku);

      const nuevoStockDep = Math.max(0, producto.stock_dep - v.cantidad);

      const { data: venta, error: ventaErr } = await supabase.from('ventas').insert({
        id: v.id,
        canal: v.canal,
        fecha: v.fecha,
        orden_meli: v.ordenMeli || null,
        comprador: v.comprador || null,
        cliente: v.cliente || null,
        sku: v.sku,
        producto: v.producto,
        cantidad: v.cantidad,
        precio_unit: v.precioUnit,
        comision: v.comision || 0,
        total: v.total,
        estado: v.estado || 'pagada',
        metodo_pago: v.metodoPago || null,
        genera_envio: v.generaEnvio || false,
        notas: v.notas || null,
      }).select().single();
      if (ventaErr) throw ventaErr;

      await supabase.from('productos').update({
        stock_dep: nuevoStockDep,
        stock_meli: nuevoStockDep,
        stock_shopify: nuevoStockDep,
        updated_at: new Date().toISOString(),
      }).eq('sku', v.sku);

      if (v.canal === 'meli' && producto.meli_id) {
        try {
          const token = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ available_quantity: nuevoStockDep }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) console.warn('⚠️ MELI error:', meliData.message);
        } catch (meliErr) {
          console.error('❌ No se pudo actualizar stock en MELI:', meliErr.message);
        }
      }

      return res.json({ venta, nuevoStock: nuevoStockDep });
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });

      const v = req.body;

      const { data, error } = await supabase.from('ventas').update({
        fecha: v.fecha,
        comprador: v.comprador || null,
        cliente: v.cliente || null,
        cantidad: v.cantidad,
        precio_unit: v.precioUnit,
        comision: v.comision || 0,
        total: v.total,
        estado: v.estado,
        metodo_pago: v.metodoPago || null,
        notas: v.notas || null,
      }).eq('id', id).select().single();

      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      const { error } = await supabase.from('ventas').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/ventas:', err);
    res.status(500).json({ error: err.message });
  }
};
