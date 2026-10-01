// api/shopify/notify.js
// POST /api/shopify/notify           → webhook orders/paid de Shopify
// GET  /api/shopify/notify?orden=ID  → reprocesar manualmente una orden

const { getSupabase } = require('../_supabase');
const { sincronizarStock, resumenSync } = require('../_stockSync');
const { getShopifyToken } = require('../_shopifyToken');
const { unidadesDeDeposito } = require('../_packs');

const SHOP = 'martinez-motos.myshopify.com';

async function procesarOrden(order, supabase, log) {
  const resultados = [];
  for (const item of order.line_items) {
    const variantId = String(item.variant_id);
    const cantidad = item.quantity;
    if (log) log.push(`Item: variant ${variantId}, x${cantidad}, $${item.price}`);

    const { data: producto } = await supabase
      .from('productos').select('*').eq('shopify_id', variantId).single();

    if (!producto) {
      const msg = `⚠️ Variante ${variantId} no encontrada en CRM`;
      console.log(msg);
      if (log) log.push(msg);
      resultados.push({ variant: variantId, error: 'Producto no encontrado' });
      continue;
    }
    if (log) log.push(`✅ Producto: ${producto.sku} - ${producto.nombre}`);

    // `cantidad` viene en unidades vendidas (packs); el depósito se lleva
    // unidades_por_venta unidades por cada una.
    const nuevoStockDep = Math.max(0, producto.stock_dep - unidadesDeDeposito(cantidad, producto));

    // Shopify ya se descontó solo la unidad que vendió, pero con packs su cuenta
    // no coincide con la nuestra (vende 1 par y el depósito pierde 2), así que
    // igual se le fija el valor que corresponde. MELI no se enteró de nada.
    const sync = await sincronizarStock(supabase, producto, nuevoStockDep);
    const nuevoStockPublicado = sync.stockPublicado;
    if (log) log.push(`✅ Stock: ${sync.stockDep} uds en depósito → ${nuevoStockPublicado} publicadas`);

    const ventaId = `V_SHOP_${order.id}_${variantId}`;
    const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single();
    if (ventaExistente) {
      const msg = `ℹ️ Venta ${ventaId} ya existe`;
      if (log) log.push(msg);
      resultados.push({ variant: variantId, estado: 'ya_existe', ventaId });
      continue;
    }

    const { error: ventaErr } = await supabase.from('ventas').insert({
      id: ventaId,
      canal: 'shopify',
      fecha: order.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      orden_meli: null,
      comprador: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || order.email || '',
      sku: producto.sku,
      producto: producto.nombre,
      cantidad,
      precio_unit: parseFloat(item.price) || 0,
      comision: 0,
      total: parseFloat(item.price) * cantidad,
      estado: 'pagada',
      genera_envio: true,
    });
    if (ventaErr) throw ventaErr;
    console.log(`✅ Venta Shopify registrada: orden ${order.id}, ${producto.nombre} x${cantidad}`);
    if (log) log.push(`✅ Venta registrada: ${ventaId}`);

    // El empuje a MELI y a Shopify ya lo hizo sincronizarStock; acá sólo se
    // deja constancia de cómo salió.
    const linea = resumenSync(producto.sku, sync);
    console.log('📉 Venta Shopify:', linea);
    if (log) log.push(linea);

    resultados.push({ variant: variantId, estado: 'registrada', ventaId, sku: producto.sku });
  }
  return resultados;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET ?orden=ID → reprocesar manualmente
  if (req.method === 'GET') {
    const orderId = req.query.orden;
    if (!orderId) return res.status(400).json({ error: 'Falta ?orden=ORDER_ID' });
    const log = [];
    try {
      const token = await getShopifyToken();
      log.push('✅ Token Shopify OK');
      const orderRes = await fetch(`https://${SHOP}/admin/api/2024-01/orders/${orderId}.json`, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if (!orderRes.ok) throw new Error(`Orden ${orderId} no encontrada (${orderRes.status})`);
      const { order } = await orderRes.json();
      log.push(`✅ Orden #${order.order_number}, ${order.line_items.length} item(s), estado: ${order.financial_status}`);
      const supabase = getSupabase();
      const resultados = await procesarOrden(order, supabase, log);
      return res.json({ ok: true, log, resultados });
    } catch (err) {
      log.push(`❌ ${err.message}`);
      return res.status(500).json({ ok: false, log, error: err.message });
    }
  }

  // POST → webhook de Shopify
  if (req.method === 'POST') {
    try {
      let order = req.body;
      if (typeof order === 'string') { try { order = JSON.parse(order); } catch(_) {} }
      if (Buffer.isBuffer(order)) { try { order = JSON.parse(order.toString()); } catch(_) {} }
      if (!order || !order.line_items) {
        console.warn('⚠️ shopify/notify: body vacío o sin line_items', typeof order);
        return res.status(200).json({ ok: true });
      }
      const supabase = getSupabase();
      await procesarOrden(order, supabase, null);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Error en /api/shopify/notify:', err.message);
      return res.status(200).json({ ok: true }); // Siempre 200 para que Shopify no reintente
    }
  }

  return res.status(200).json({ ok: true });
};
