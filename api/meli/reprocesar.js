// api/meli/reprocesar.js
// GET /api/meli/reprocesar?orden=ID

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const ZONAS_KEYWORDS = {
  1: ['pajas blancas', 'santiago vazquez', 'paso de la arena', 'ciudad del plata'],
  2: ['la paz', 'colon', 'lezica', 'abayuba', 'jardines del hipodromo'],
  3: ['toledo', 'manga', 'piedras blancas', 'flor de maronas', 'maronas', 'ituzaingo'],
  4: ['barros blancos', 'pueblo nuevo', 'bolivar', 'las canteras'],
  5: ['pocitos', 'buceo', 'malvin', 'punta carretas', 'parque rodo', 'palermo', 'cordon', 'tres cruces', 'villa espanola', 'union'],
  6: ['punta gorda', 'carrasco', 'shangrila', 'neptunia', 'el pinar'],
  7: ['ciudad vieja', 'centro', 'goes', 'la comercial', 'aguada', 'reducto', 'belvedere', 'la blanqueada', 'figurita', 'jacinto vera', 'sayago', 'nuevo paris', 'cerro', 'la teja', 'paso molino', 'penarol'],
  8: ['progreso', 'las piedras', 'sauce', 'empalme olmos', 'juanico'],
  9: ['pando', 'toledo este', 'lagomar', 'solymar', 'la floresta'],
  10: ['ciudad de la costa', 'atlantida', 'parque del plata', 'salinas', 'costa'],
  11: ['canelones ciudad', 'canelones capital', '14 de julio'],
};
const COSTOS_GESTIONPOST = { 1:169,2:169,3:169,4:169,5:169,6:169,7:139,8:200,9:200,10:200,11:200 };

function normalizarTexto(t) {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function detectarZona(dir) {
  if (!dir) return null;
  const d = normalizarTexto(dir);
  for (const [zona, kws] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of kws) { if (d.includes(normalizarTexto(kw))) return parseInt(zona); }
  }
  return null;
}
function calcularComision(precioUnit, cantidad, costoEnvio = 0) {
  // Comisión = 15% del precio + costo de envío que cobra MELI
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

    // Obtener shipment para determinar tipo de envío, dirección y costo real
    const shippingId = order.shipping?.id;
    let logisticType = '';
    let direccion = null;
    let costoEnvioReal = 0;
    if (shippingId) {
      try {
        const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const shipData = await shipRes.json();
        logisticType = shipData?.logistic_type || '';
        costoEnvioReal = shipData?.shipping_option?.list_cost || shipData?.base_cost || 0;
        if (shipData?.receiver_address) {
          const addr = shipData.receiver_address;
          direccion = `${addr.street_name} ${addr.street_number}, ${addr.city?.name}, ${addr.state?.name}`;
        }
      } catch(_) {}
    }
    log.push(`📍 Dirección: ${direccion || 'no disponible'}`);

    const esFlex = logisticType === 'fulfillment' || logisticType === 'self_service';
    const tipoEnvio = esFlex ? 'gestionpost' : 'mercado_envios';
    log.push(`📬 Tipo de envío: ${tipoEnvio} (logistic_type: "${logisticType}")`);

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

      // Para Flex: costo real del envío (lo pagás vos). Para ME: $0 (ya incluido en comisión)
      const costoEnvioFinal = esFlex ? costoEnvioReal : 0;
      const comisionItem = hasFeeDetails
        ? Math.round((totalFee * (precioUnit * cantidad) / orderTotalCalc) * 100) / 100
        : Math.abs(item.sale_fee || 0);
      log.push(`💰 Comisión: $${comisionItem} (${tipoEnvio})`);

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
            direccion: direccion || null, costo: costoEnvioFinal,
          });
          log.push(`✅ Envío: ${tipoEnvio} $${costoEnvioFinal}`);
        }
      }
      resultados.push({ item: meliItemId, estado: 'registrada', ventaId, comision: comisionItem, tipoEnvio });
    }

    return res.json({ ok: true, log, resultados });
  } catch (err) {
    return res.json({ ok: false, log, error: err.message });
  }
};
