// api/meli/reprocesar.js
// GET /api/meli/reprocesar?orden=2000011960549189

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

    // Obtener user id
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const me = await meRes.json();
    log.push(`✅ Usuario: ${me.nickname} (${me.id}) site: ${me.site_id}`);

    // Intentar múltiples endpoints para encontrar la orden
    let order = null;

    // Intento 1: endpoint directo
    log.push(`Intento 1: GET /orders/${orderId}`);
    const r1 = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const d1 = await r1.json();
    if (!d1.error) {
      order = d1;
      log.push(`✅ Encontrada con endpoint directo`);
    } else {
      log.push(`❌ Endpoint directo: ${d1.message}`);
    }

    // Intento 2: buscar por seller
    if (!order) {
      log.push(`Intento 2: GET /orders/search?seller=${me.id}&q=${orderId}`);
      const r2 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&q=${orderId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const d2 = await r2.json();
      if (d2.results && d2.results.length > 0) {
        order = d2.results[0];
        log.push(`✅ Encontrada por search`);
      } else {
        log.push(`❌ Search: ${JSON.stringify(d2.error || d2.message || 'sin resultados')}`);
      }
    }

    // Intento 3: buscar últimas órdenes y filtrar
    if (!order) {
      log.push(`Intento 3: GET /orders/search?seller=${me.id}&sort=date_desc`);
      const r3 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&sort=date_desc&limit=20`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const d3 = await r3.json();
      if (d3.results) {
        log.push(`Órdenes recientes encontradas: ${d3.results.length}`);
        log.push(`IDs: ${d3.results.map(o => o.id).join(', ')}`);
        const found = d3.results.find(o => String(o.id) === String(orderId));
        if (found) {
          order = found;
          log.push(`✅ Encontrada en listado reciente`);
        } else {
          log.push(`❌ No está en las últimas 20 órdenes`);
        }
      } else {
        log.push(`❌ No se pudo listar órdenes: ${JSON.stringify(d3)}`);
      }
    }

    if (!order) {
      return res.json({ ok: false, log, error: 'No se pudo obtener la orden por ningún endpoint' });
    }

    log.push(`Orden estado: ${order.status}, items: ${order.order_items?.length}`);

    if (order.status !== 'paid') {
      return res.json({ ok: false, log, error: `Orden no pagada (estado: ${order.status})`, order_status: order.status });
    }

    const resultados = [];

    for (const item of order.order_items || []) {
      const meliItemId = item.item?.id;
      const cantidad = item.quantity || 1;
      const precioUnit = item.unit_price || 0;

      log.push(`Item: ${meliItemId}, x${cantidad}, $${precioUnit}`);

      const { data: producto } = await supabase
        .from('productos')
        .select('*')
        .eq('meli_id', meliItemId)
        .single();

      if (!producto) {
        const { data: todos } = await supabase
          .from('productos').select('sku, meli_id').not('meli_id', 'is', null);
        log.push(`⚠️ meli_id=${meliItemId} no encontrado. meli_ids cargados: ${JSON.stringify(todos?.map(p => p.meli_id))}`);
        resultados.push({ item: meliItemId, error: 'Producto no encontrado' });
        continue;
      }

      log.push(`✅ Producto: ${producto.sku} - ${producto.nombre}`);

      const ventaId = `V_MELI_${order.id}_${meliItemId}`;
      const { data: ventaExistente } = await supabase
        .from('ventas').select('id').eq('id', ventaId).single();

      if (ventaExistente) {
        log.push(`ℹ️ Venta ${ventaId} ya existe`);
        resultados.push({ item: meliItemId, estado: 'ya_existe', ventaId });
        continue;
      }

      const nuevoStockDep  = Math.max(0, producto.stock_dep  - cantidad);
      const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);

      await supabase.from('productos').update({
        stock_dep: nuevoStockDep, stock_meli: nuevoStockMeli,
        updated_at: new Date().toISOString(),
      }).eq('sku', producto.sku);
      log.push(`✅ Stock: dep=${nuevoStockDep} meli=${nuevoStockMeli}`);

      const { error: ventaErr } = await supabase.from('ventas').insert({
        id: ventaId, canal: 'meli',
        fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.id),
        comprador: order.buyer?.nickname || '',
        sku: producto.sku, producto: producto.nombre,
        cantidad, precio_unit: precioUnit, comision: 0,
        total: precioUnit * cantidad, estado: 'pagada',
        genera_envio: true, notas: 'Reprocesada manualmente',
      });

      if (ventaErr) {
        log.push(`❌ Error venta: ${ventaErr.message}`);
        resultados.push({ item: meliItemId, error: ventaErr.message });
      } else {
        log.push(`✅ Venta registrada: ${ventaId}`);
        resultados.push({ item: meliItemId, estado: 'registrada', ventaId });
      }
    }

    return res.json({ ok: true, log, resultados });

  } catch (err) {
    return res.json({ ok: false, log, error: err.message });
  }
};
