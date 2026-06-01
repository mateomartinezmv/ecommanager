// api/ventas.js
// GET  /api/ventas → listar
// GET  /api/ventas?canceladas=1 → listar canceladas
// POST /api/ventas → crear (también descuenta stock y actualiza MELI si aplica)
// DELETE /api/ventas?id=XX → cancelar (restaura stock, elimina envío, registra cancelación)

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
      if (req.query.canceladas) {
        // Devolver ventas canceladas
        const { data, error } = await supabase
          .from('ventas_canceladas')
          .select('*')
          .order('cancelada_at', { ascending: false });
        if (error) throw error;
        return res.json(data);
      }

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

      // 5. Si es venta MELI y tiene meli_id → actualizar stock en MELI
      if (v.canal === 'meli' && producto.meli_id) {
        try {
          const token = await getMeliToken();
          const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ available_quantity: nuevoStockMeli }),
          });
          const meliData = await meliRes.json();
          if (meliData.error) console.warn('⚠️ MELI error:', meliData.message);
          else console.log(`✅ Stock MELI actualizado: ${producto.meli_id} → ${nuevoStockMeli}`);
        } catch (meliErr) {
          console.error('❌ No se pudo actualizar stock en MELI:', meliErr.message);
        }
      }

      return res.json({ venta, nuevoStockDep, nuevoStockMeli });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;

      // 1. Obtener la venta antes de eliminar
      const { data: venta, error: ventaErr } = await supabase
        .from('ventas')
        .select('*')
        .eq('id', id)
        .single();
      if (ventaErr || !venta) throw new Error('Venta no encontrada: ' + id);

      // 2. Obtener el producto para restaurar stock
      const { data: producto } = await supabase
        .from('productos')
        .select('*')
        .eq('sku', venta.sku)
        .single();

      if (producto) {
        // 3. Restaurar stock
        const stockDepRestaurado = producto.stock_dep + venta.cantidad;
        const stockMeliRestaurado = venta.canal === 'meli'
          ? producto.stock_meli + venta.cantidad
          : producto.stock_meli;

        await supabase.from('productos').update({
          stock_dep: stockDepRestaurado,
          stock_meli: stockMeliRestaurado,
          updated_at: new Date().toISOString(),
        }).eq('sku', venta.sku);

        console.log(`🔄 Stock restaurado: ${venta.sku} depósito +${venta.cantidad} → ${stockDepRestaurado}`);

        // 4. Si era MELI y tiene meli_id → restaurar stock en MELI también
        if (venta.canal === 'meli' && producto.meli_id) {
          try {
            const token = await getMeliToken();
            const meliRes = await fetch(`https://api.mercadolibre.com/items/${producto.meli_id}`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ available_quantity: stockMeliRestaurado }),
            });
            const meliData = await meliRes.json();
            if (meliData.error) console.warn('⚠️ MELI stock restore warning:', meliData.message);
            else console.log(`✅ Stock MELI restaurado: ${producto.meli_id} → ${stockMeliRestaurado}`);
          } catch (meliErr) {
            console.error('❌ Error restaurando stock MELI:', meliErr.message);
          }
        }
      }

      // 5. Eliminar envío asociado si existe
      const { data: envioAsociado } = await supabase
        .from('envios')
        .select('id')
        .eq('venta_id', id)
        .single();

      if (envioAsociado) {
        await supabase.from('envios').delete().eq('id', envioAsociado.id);
        console.log(`🗑️ Envío eliminado: ${envioAsociado.id}`);
      }

      // 6. Registrar en ventas_canceladas
      await supabase.from('ventas_canceladas').insert({
        venta_id: venta.id,
        canal: venta.canal,
        fecha_venta: venta.fecha,
        cancelada_at: new Date().toISOString(),
        orden_meli: venta.orden_meli || null,
        comprador: venta.comprador || venta.cliente || null,
        sku: venta.sku,
        producto: venta.producto,
        cantidad: venta.cantidad,
        precio_unit: venta.precio_unit,
        total: venta.total,
        tenia_envio: !!envioAsociado,
      }).catch(err => console.warn('No se pudo registrar en ventas_canceladas:', err.message));

      // 7. Eliminar la venta
      const { error } = await supabase.from('ventas').delete().eq('id', id);
      if (error) throw error;

      return res.json({ ok: true, stockRestaurado: !!producto, envioEliminado: !!envioAsociado });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/ventas:', err);
    res.status(500).json({ error: err.message });
  }
};
