// api/meli/reprocesar.js
// GET /api/meli/reprocesar?orden=ID

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { detectarZona, detectarZonaDesdeShipData, COSTOS_ENVIOSUY } = require('../_flexZonas');

const FLEX_TYPES = ['self_service', 'self_service_flex', 'fulfillment'];

function calcularComision(precioUnit, cantidad, costoEnvio = 0) {
  const base = Math.round(precioUnit * cantidad * 0.15 * 100) / 100;
  return Math.round((base + costoEnvio) * 100) / 100;
}

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

    const meRes = await fetch('https://api.mercadolibre.com/users/me', { headers: { 'Authorization': `Bearer ${token}` } });
    const me = await meRes.json();
    log.push(`✅ Usuario: ${me.nickname} (${me.id}) site: ${me.site_id}`);

    let order = null;
    log.push(`Intento 1: GET /orders/${orderId}`);
    const r1 = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const d1 = await r1.json();
    if (!d1.error) { order = d1; log.push('✅ Encontrada con endpoint directo'); }
    else log.push(`❌ Endpoint directo: ${d1.message}`);

    if (!order) {
      log.push(`Intento 2: GET /orders/search?seller=${me.id}&q=${orderId}`);
      const r2 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&q=${orderId}`, { headers: { 'Authorization': `Bearer ${token}` } });
      const d2 = await r2.json();
      if (d2.results?.length > 0) { order = d2.results[0]; log.push('✅ Encontrada por search'); }
      else log.push(`❌ Search: "${d2.error || 'sin resultados'}"`);
    }

    if (!order) {
      log.push(`Intento 3: GET /orders/search?seller=${me.id}&sort=date_desc`);
      const r3 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&sort=date_desc&limit=20`, { headers: { 'Authorization': `Bearer ${token}` } });
      const d3 = await r3.json();
      if (d3.results) {
        log.push(`Órdenes recientes: ${d3.results.length} | IDs: ${d3.results.map(o => o.id).join(', ')}`);
        const found = d3.results.find(o => String(o.id) === String(orderId));
        if (found) { order = found; log.push('✅ Encontrada en listado reciente'); }
        else log.push('❌ No está en las últimas 20 órdenes');
      }
    }

    if (!order) return res.json({ ok: false, log, error: 'No se pudo obtener la orden por ningún endpoint' });

    log.push(`Orden estado: ${order.status}, items: ${order.order_items?.length}`);
    if (order.status !== 'paid') return res.json({ ok: false, log, error: `Orden no pagada (estado: ${order.status})` });

    // Obtener shipment con datos estructurados
    const shippingId = order.shipping?.id;
    let logisticType = '';
    let direccion = null;
    let neighborhood = null;
    let zonaEnvio = null;
    let shipDataRef = null;

    if (shippingId) {
      try {
        const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        shipDataRef = await shipRes.json();
        logisticType = shipDataRef?.logistic_type || '';
        neighborhood = shipDataRef?.receiver_address?.neighborhood?.name || null;
        if (shipDataRef?.receiver_address) {
          const addr = shipDataRef.receiver_address;
          direccion = [addr.street_name, addr.street_number, neighborhood, addr.city?.name, addr.state?.name].filter(Boolean).join(', ');
        }
      } catch(_) {}
    }
    log.push(`📍 Barrio: "${neighborhood || '—'}" | Dirección: ${direccion || 'no disponible'}`);

    const esFlex = FLEX_TYPES.includes(logisticType);
    log.push(`📬 Tipo de envío: ${esFlex ? 'flex/EnviosUy' : 'mercado_envios'} (logistic_type: "${logisticType}")`);

    // Detectar zona Flex usando datos estructurados de MELI (barrio primero)
    if (esFlex && shipDataRef) {
      zonaEnvio = detectarZonaDesdeShipData(shipDataRef);
      if (!zonaEnvio && direccion) zonaEnvio = detectarZona(direccion);
    }
    log.push(`🗺️ Zona: ${zonaEnvio ?? 'no detectada'}`);

    const costoEnvioFinal = esFlex ? (zonaEnvio ? (COSTOS_ENVIOSUY[zonaEnvio] ?? 0) : 0) : 0;
    const tipoEnvio = esFlex ? 'enviosuy' : 'mercado_envios';

    // Comisión desde fee_details
    const feeDetails = order.fee_details || [];
    const totalFee = feeDetails
      .filter(f => f.type === 'mercadopago_fee' || f.type === 'ml_fee')
      .reduce((s, f) => s + Math.abs(f.amount || 0), 0);
    const hasFeeDetails = totalFee > 0;
    const orderTotalCalc = (order.order_items || []).reduce((s, i) => s + (i.unit_price * i.quantity), 0) || 1;

    const resultados = [];

    for (const item of order.order_items || []) {
      const meliItemId = item.item?.id;
      const cantidad = item.quantity || 1;
      const precioUnit = item.unit_price || 0;
      log.push(`Item: ${meliItemId}, x${cantidad}, $${precioUnit}`);

      const { data: producto } = await supabase.from('productos').select('*').eq('meli_id', meliItemId).single();
      if (!producto) { log.push(`⚠️ meli_id=${meliItemId} no encontrado`); resultados.push({ item: meliItemId, error: 'Producto no encontrado' }); continue; }
      log.push(`✅ Producto: ${producto.sku} - ${producto.nombre}`);

      const ventaId = `V_MELI_${order.id}_${meliItemId}`;
      const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single();
      if (ventaExistente) { log.push(`ℹ️ Venta ${ventaId} ya existe`); resultados.push({ item: meliItemId, estado: 'ya_existe', ventaId }); continue; }

      const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
      await supabase.from('productos').update({ stock_dep: nuevoStockDep, stock_meli: nuevoStockDep, stock_shopify: nuevoStockDep, updated_at: new Date().toISOString() }).eq('sku', producto.sku);
      log.push(`✅ Stock: ${nuevoStockDep}`);

      const comisionItem = hasFeeDetails
        ? Math.round((totalFee * (precioUnit * cantidad) / orderTotalCalc) * 100) / 100
        : Math.abs(item.sale_fee || 0);
      log.push(`💰 Comisión: $${comisionItem} | Envío: ${tipoEnvio} zona ${zonaEnvio ?? '?'} $${costoEnvioFinal}`);

      const { error: ventaErr } = await supabase.from('ventas').insert({
        id: ventaId, canal: 'meli',
        fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.id), comprador: order.buyer?.nickname || '',
        sku: producto.sku, producto: producto.nombre,
        cantidad, precio_unit: precioUnit, comision: comisionItem,
        total: precioUnit * cantidad, estado: 'pagada',
        genera_envio: !!shippingId, notas: 'Reprocesada manualmente',
      });
      if (ventaErr) { log.push(`❌ Error venta: ${ventaErr.message}`); resultados.push({ item: meliItemId, error: ventaErr.message }); continue; }
      log.push(`✅ Venta registrada: ${ventaId}`);

      if (shippingId) {
        const envioId = `E_MELI_${order.id}_${meliItemId}`;
        const { data: envioExistente } = await supabase.from('envios').select('id').eq('id', envioId).single();
        if (!envioExistente) {
          await supabase.from('envios').insert({
            id: envioId, venta_id: ventaId, orden: String(order.id),
            comprador: order.buyer?.nickname || '', producto: producto.nombre,
            transportista: tipoEnvio,
            tracking: null, fecha_despacho: null, estado: 'pendiente',
            direccion: direccion || null, costo: costoEnvioFinal, zona: zonaEnvio,
          });
          log.push(`✅ Envío creado: ${tipoEnvio} | zona ${zonaEnvio ?? '?'} | $${costoEnvioFinal}`);
        }
      }
      resultados.push({ item: meliItemId, estado: 'registrada', ventaId, comision: comisionItem, tipoEnvio, zona: zonaEnvio, costo: costoEnvioFinal });
    }

    return res.json({ ok: true, log, resultados });
  } catch (err) {
    return res.json({ ok: false, log, error: err.message });
  }
};
