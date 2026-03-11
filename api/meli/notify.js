// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const body = req.body || {};
  const { topic, resource } = body;
  const supabase = getSupabase();

  try {
    await supabase.from('meli_notify_log').insert({
      topic: topic || 'desconocido',
      resource: resource || '',
      raw: JSON.stringify(body),
      recibido_at: new Date().toISOString(),
    });
  } catch (_) {}

  console.log(`[MELI NOTIFY] topic=${topic} resource=${resource}`);

  if (topic === 'orders_v2' || topic === 'orders') {
    try {
      await handleOrder(resource, supabase);
    } catch (err) {
      console.error('[MELI NOTIFY] Error:', err.message);
    }
  }

  return res.status(200).json({ ok: true });
};

async function getOrder(orderId, token) {
  // Intento 1: endpoint directo
  const r1 = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const d1 = await r1.json();
  if (!d1.error) return d1;

  // Intento 2: search por seller
  const meRes = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const me = await meRes.json();

  const r2 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&q=${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const d2 = await r2.json();
  if (d2.results && d2.results.length > 0) return d2.results[0];

  // Intento 3: últimas órdenes
  const r3 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&sort=date_desc&limit=20`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const d3 = await r3.json();
  if (d3.results) {
    const found = d3.results.find(o => String(o.id) === String(orderId));
    if (found) return found;
  }

  throw new Error(`No se pudo obtener la orden ${orderId}`);
}

async function handleOrder(resource, supabase) {
  const token = await getMeliToken();
  const orderId = String(resource).replace(/\D/g, '').trim();
  if (!orderId) throw new Error('ID de orden inválido: ' + resource);

  console.log(`[MELI NOTIFY] Buscando orden ${orderId}...`);
  const order = await getOrder(orderId, token);

  if (order.status !== 'paid') {
    console.log(`[MELI NOTIFY] Orden ${orderId} ignorada (${order.status})`);
    return;
  }

  console.log(`[MELI NOTIFY] Orden ${orderId} OK, ${order.order_items?.length} item(s)`);

  for (const item of order.order_items || []) {
    const meliItemId = item.item?.id;
    const cantidad = item.quantity || 1;
    const precioUnit = item.unit_price || 0;
    if (!meliItemId) continue;

    const { data: producto } = await supabase
      .from('productos').select('*').eq('meli_id', meliItemId).single();

    let skuFinal, nombreFinal;

    if (!producto) {
      const skuAuto = `MELI-${meliItemId}`;
      let nombreItem = item.item?.title || `Producto MELI ${meliItemId}`;
      try {
        const ir = await fetch(`https://api.mercadolibre.com/items/${meliItemId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const id = await ir.json();
        if (!id.error) nombreItem = id.title;
      } catch (_) {}

      const { data: existe } = await supabase.from('productos').select('sku').eq('sku', skuAuto).single();
      if (!existe) {
        await supabase.from('productos').insert({
          sku: skuAuto, nombre: nombreItem,
          stock_dep: 0, stock_meli: 0, costo: 0,
          precio: precioUnit, alerta_min: 3,
          meli_id: meliItemId, notas: 'Auto-creado por webhook MELI',
        });
      }
      skuFinal = skuAuto;
      nombreFinal = nombreItem;
    } else {
      const nuevoStockDep  = Math.max(0, producto.stock_dep  - cantidad);
      const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);
      await supabase.from('productos').update({
        stock_dep: nuevoStockDep, stock_meli: nuevoStockMeli,
        updated_at: new Date().toISOString(),
      }).eq('sku', producto.sku);
      console.log(`[MELI NOTIFY] Stock: ${producto.sku} dep=${nuevoStockDep} meli=${nuevoStockMeli}`);
      skuFinal = producto.sku;
      nombreFinal = producto.nombre;
    }

    const ventaId = `V_MELI_${order.id}_${meliItemId}`;
    const { data: existe } = await supabase.from('ventas').select('id').eq('id', ventaId).single();
    if (existe) { console.log(`[MELI NOTIFY] Venta ${ventaId} ya existe`); continue; }

    const { error } = await supabase.from('ventas').insert({
      id: ventaId, canal: 'meli',
      fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      orden_meli: String(order.id),
      comprador: order.buyer?.nickname || '',
      sku: skuFinal, producto: nombreFinal,
      cantidad, precio_unit: precioUnit, comision: 0,
      total: precioUnit * cantidad, estado: 'pagada',
      genera_envio: true, notas: 'Auto-registrada por webhook MELI',
    });

    if (error) throw new Error(`Error insertando venta: ${error.message}`);
    console.log(`[MELI NOTIFY] ✅ Venta registrada: ${ventaId}`);
  }
}
