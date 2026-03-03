// api/ventas.js
// GET  /api/ventas → listar
// POST /api/ventas → crear (también descuenta stock y actualiza MELI si aplica)

const { getSupabase } = require('./_supabase');
const { getMeliToken } = require('./_meliToken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
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

      // 1. Obtener el producto
      const { data: producto, error: prodErr } = await supabase
        .from('productos')
        .select('*')
        .eq('sku', v.sku)
        .single();
      if (prodErr || !producto) throw new Error('Producto no encontrado: ' + v.sku);

      // 2. Calcular nuevo stock
      const nuevoStockDep = Math.max(0, producto.stock_dep - v.cantidad);
      const nuevoStockMeli = v.canal === 'meli'
        ? Math.max(0, producto.stock_meli - v.cantidad)
        : producto.stock_meli;

      // 3. Guardar la venta
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

      // 4. Actualizar stock en Supabase
      await supabase.from('productos').update({
        stock_dep: nuevoStockDep,
        stock_meli: nuevoStockMeli,
        updated_at: new Date().toISOString(),
      }).eq('sku', v.sku);

      // 5. Si es venta MELI y tiene meli_id → actualizar stock en MELI automáticamente
      if (v.canal === 'meli' && producto.meli_id) {
        try {
          console.log(`🔄 Intentando actualizar stock MELI: ${producto.meli_id} → ${nuevoStockMeli}`);
          const token = await getMeliToken();
          console.log(`🔑 Token obtenido OK`);
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ available_quantity: nuevoStockMeli }),
          });
          const meliData = await meliRes.json();
          console.log(`📦 Respuesta MELI:`, JSON.stringify(meliData));
          if (meliData.error) console.warn('⚠️ MELI error:', meliData.message);
          else console.log(`✅ Stock MELI actualizado: ${producto.meli_id} → ${nuevoStockMeli}`);
        } catch (meliErr) {
          console.error('❌ No se pudo actualizar stock en MELI:', meliErr.message);
        }
      } else {
        console.log(`ℹ️ Sin actualización MELI — canal: ${v.canal}, meli_id: ${producto.meli_id}`);
      }

      return res.json({ venta, nuevoStockDep, nuevoStockMeli });
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
