// api/meli/reprocesar.js
// GET /api/meli/reprocesar?orden=2000015427845516 → reintenta procesar una orden y devuelve el resultado detallado

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const orderId = req.query.orden;
  if (!orderId) return res.status(400).json({ error: 'Falta ?orden=ID' });

  const supabase = getSupabase();
  const log = [];

  try {
    log.push('Obteniendo token MELI...');
    const token = await getMeliToken();
    log.push('✅ Token OK');

    log.push(`Consultando orden ${orderId}...`);
    const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const order = await orderRes.json();

    if (order.error) {
      return res.json({ ok: false, log, error: `MELI error: ${order.message}`, order });
    }

    log.push(`✅ Orden obtenida. Estado: ${order.status}, Items: ${order.order_items?.length}`);

    if (order.status !== 'paid') {
      return res.json({ ok: false, log, error: `Orden no está pagada (estado: ${order.status})` });
    }

    const resultados = [];

    for (const item of order.order_items || []) {
      const meliItemId = item.item?.id;
      const cantidad = item.quantity || 1;
      const precioUnit = item.unit_price || 0;

      log.push(`Procesando item: ${meliItemId}, cantidad: ${cantidad}, precio: ${precioUnit}`);

      // Buscar producto
      const { data: producto, error: prodErr } = await supabase
        .from('productos')
        .select('*')
        .eq('meli_id', meliItemId)
        .single();

      if (prodErr || !producto) {
        log.push(`⚠️ Producto con meli_id=${meliItemId} NO encontrado en DB`);

        // Listar todos los meli_id cargados para comparar
        const { data: todosProductos } = await supabase
          .from('productos')
          .select('sku, nombre, meli_id')
          .not('meli_id', 'is', null);

        log.push(`Productos con meli_id cargado: ${JSON.stringify(todosProductos?.map(p => ({ sku: p.sku, meli_id: p.meli_id })))}`);
        resultados.push({ item: meliItemId, error: 'Producto no encontrado' });
        continue;
      }

      log.push(`✅ Producto encontrado: ${producto.sku} - ${producto.nombre}`);

      // Verificar si la venta ya existe
      const ventaId = `V_MELI_${order.id}_${meliItemId}`;
      const { data: ventaExistente } = await supabase
        .from('ventas').select('id').eq('id', ventaId).single();

      if (ventaExistente) {
        log.push(`ℹ️ Venta ${ventaId} ya existe`);
        resultados.push({ item: meliItemId, estado: 'ya_existe', ventaId });
        continue;
      }

      // Descontar stock
      const nuevoStockDep  = Math.max(0, producto.stock_dep  - cantidad);
      const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);

      const { error: stockErr } = await supabase.from('productos').update({
        stock_dep: nuevoStockDep,
        stock_meli: nuevoStockMeli,
        updated_at: new Date().toISOString(),
      }).eq('sku', producto.sku);

      if (stockErr) {
        log.push(`❌ Error actualizando stock: ${stockErr.message}`);
      } else {
        log.push(`✅ Stock actualizado: dep=${nuevoStockDep} meli=${nuevoStockMeli}`);
      }

      // Insertar venta
      const { error: ventaErr } = await supabase.from('ventas').insert({
        id: ventaId,
        canal: 'meli',
        fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.id),
        comprador: order.buyer?.nickname || order.buyer?.first_name || '',
        sku: producto.sku,
        producto: producto.nombre,
        cantidad,
        precio_unit: precioUnit,
        comision: 0,
        total: precioUnit * cantidad,
        estado: 'pagada',
        genera_envio: true,
        notas: 'Reprocesada manualmente',
      });

      if (ventaErr) {
        log.push(`❌ Error insertando venta: ${ventaErr.message}`);
        resultados.push({ item: meliItemId, error: ventaErr.message });
      } else {
        log.push(`✅ Venta registrada: ${ventaId}`);
        resultados.push({ item: meliItemId, estado: 'registrada', ventaId });
      }
    }

    return res.json({ ok: true, log, resultados, orden: { id: order.id, estado: order.status, comprador: order.buyer?.nickname } });

  } catch (err) {
    return res.json({ ok: false, log, error: err.message });
  }
};
