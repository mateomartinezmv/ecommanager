// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, calificaciones, items)

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

// ── Telegram helper ──────────────────────────────────────────
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(err => console.error('Telegram error:', err.message));
}
// ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.status(200).json({ ok: true });
  if (req.method !== 'POST') return;

  const { topic, resource } = req.body || {};
  console.log('MELI notify:', topic, resource);

  try {
    if (topic === 'orders_v2' || topic === 'orders') {
      await handleOrder(resource);
    } else if (topic === 'feedback') {
      await handleFeedback(resource);
    } else if (topic === 'items') {
      await handleItem(resource);
    } else if (topic === 'shipments') {
      await handleShipment(resource);
    }
  } catch (err) {
    console.error('Error procesando notificación MELI:', err.message);
  }
};

// ── ÓRDENES ──────────────────────────────────────────────────
async function handleOrder(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const orderId = resource.replace('/orders/', '').split('/')[0];
  const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const order = await orderRes.json();
  if (order.error) throw new Error(order.message);

  if (order.status !== 'paid') return;

  for (const item of order.order_items) {
    const meliItemId = item.item.id;
    const cantidad = item.quantity;

    const { data: producto } = await supabase
      .from('productos')
      .select('*')
      .eq('meli_id', meliItemId)
      .single();

    if (!producto) {
      console.log(`Producto con MELI ID ${meliItemId} no encontrado en DB`);
      continue;
    }

    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
    const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);

    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      stock_meli: nuevoStockMeli,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);

    const ventaId = 'V_MELI_' + order.id + '_' + item.item.id;
    const { data: ventaExistente } = await supabase
      .from('ventas').select('id').eq('id', ventaId).single();

    if (!ventaExistente) {
      await supabase.from('ventas').insert({
        id: ventaId,
        canal: 'meli',
        fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.id),
        comprador: order.buyer?.nickname || '',
        sku: producto.sku,
        producto: producto.nombre,
        cantidad,
        precio_unit: item.unit_price,
        comision: 0,
        total: item.unit_price * cantidad,
        estado: 'pagada',
        genera_envio: true,
      });
      console.log(`✅ Venta MELI registrada: orden ${order.id}`);
    } else {
      console.log(`ℹ️ Venta ya existente: orden ${order.id} — solo notificando`);
    }

    // Telegram — siempre notifica
    const total = (item.unit_price * cantidad).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const stockAlerta = nuevoStockDep <= producto.alerta_min;
    await sendTelegram(
      `🛒 <b>Nueva venta en MELI</b>\n\n` +
      `📦 <b>Producto:</b> ${producto.nombre}\n` +
      `🔢 <b>Cantidad:</b> ${cantidad}\n` +
      `💰 <b>Total:</b> $${total}\n` +
      `👤 <b>Comprador:</b> ${order.buyer?.nickname || '—'}\n` +
      `🔖 <b>Orden:</b> ${order.id}\n` +
      `📊 <b>Stock depósito:</b> ${nuevoStockDep} uds` +
      (stockAlerta ? '\n⚠️ <b>¡Stock bajo! Revisá el inventario.</b>' : '') +
      (nuevoStockDep === 0 ? '\n🔴 <b>¡SIN STOCK! Producto agotado.</b>' : '')
    );
  }
}

// ── CALIFICACIONES ───────────────────────────────────────────
async function handleFeedback(resource) {
  const token = await getMeliToken();

  const feedbackId = resource.split('/').pop();
  const res = await fetch(`https://api.mercadolibre.com/feedback/${feedbackId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const feedback = await res.json();
  if (feedback.error) {
    console.log('Feedback no disponible:', feedback.message);
    return;
  }

  // Solo notificar calificaciones recibidas (de compradores)
  if (feedback.role !== 'seller') return;

  const rating = feedback.rating;
  const emoji = rating === 'positive' ? '⭐' : rating === 'negative' ? '😡' : '😐';
  const label = rating === 'positive' ? 'Positiva' : rating === 'negative' ? 'Negativa' : 'Neutral';
  const comentario = feedback.message ? `\n💬 <b>Comentario:</b> "${feedback.message}"` : '';

  await sendTelegram(
    `${emoji} <b>Nueva calificación en MELI</b>\n\n` +
    `📊 <b>Tipo:</b> ${label}\n` +
    `👤 <b>Comprador:</b> ${feedback.from?.nickname || '—'}` +
    comentario
  );
}

// ── ITEMS (publicaciones pausadas / sin stock) ───────────────
async function handleItem(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const itemId = resource.split('/').pop();
  const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const item = await res.json();
  if (item.error) {
    console.log('Item no disponible:', item.message);
    return;
  }

  // Solo notificar si se pausó
  if (item.status !== 'paused') return;

  // Buscar el producto en Supabase para dar más contexto
  const { data: producto } = await supabase
    .from('productos').select('nombre, stock_dep, stock_meli').eq('meli_id', itemId).single();

  const nombre = producto?.nombre || item.title;
  const motivo = item.available_quantity === 0
    ? 'sin stock disponible'
    : 'pausada manualmente o por MELI';

  await sendTelegram(
    `🔄 <b>Publicación pausada en MELI</b>\n\n` +
    `📦 <b>Producto:</b> ${nombre}\n` +
    `🔖 <b>ID MELI:</b> ${itemId}\n` +
    `❓ <b>Motivo:</b> ${motivo}\n` +
    `📊 <b>Stock depósito:</b> ${producto?.stock_dep ?? '—'} uds\n\n` +
    `Entrá al CRM para reactivarla cuando tengas stock.`
  );
}

// ── ENVÍOS (shipments) ───────────────────────────────────────
async function handleShipment(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const shipmentId = resource.split('/').pop();
  const res = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const shipment = await res.json();
  if (shipment.error) {
    console.log('Shipment no disponible:', shipment.message);
    return;
  }

  // Solo procesar cuando se entrega
  if (shipment.status !== 'delivered') return;

  const orderId = String(shipment.order_id);

  // Buscar el envío en el CRM por orden_meli
  const { data: envio } = await supabase
    .from('envios')
    .select('*')
    .eq('orden', orderId)
    .single();

  // Marcar como entregado en el CRM si existe y no está ya entregado
  if (envio && envio.estado !== 'entregado') {
    await supabase.from('envios')
      .update({ estado: 'entregado' })
      .eq('id', envio.id);
    console.log(`✅ Envío marcado como entregado: orden ${orderId}`);
  }

  // Notificar a Telegram siempre
  const comprador = envio?.comprador || shipment.receiver?.receiver_name || '—';
  const producto = envio?.producto || '—';
  const crmActualizado = envio ? '✅ CRM actualizado automáticamente.' : '⚠️ No se encontró el envío en el CRM.';

  await sendTelegram(
    `✅ <b>Envío entregado</b>\n\n` +
    `👤 <b>Comprador:</b> ${comprador}\n` +
    `📦 <b>Producto:</b> ${producto}\n` +
    `🔖 <b>Orden:</b> ${orderId}\n` +
    `🚚 <b>Tracking:</b> ${envio?.tracking || shipmentId}\n\n` +
    crmActualizado
  );
}
