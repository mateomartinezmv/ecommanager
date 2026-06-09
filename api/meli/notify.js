// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, calificaciones, items)

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

// ── Telegram helper ──────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Telegram HTTP ${res.status}:`, body.slice(0, 200));
    }
  } catch (err) {
    console.error('Telegram error:', err.message, err.cause?.message || '');
  }
}
// ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

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
    } else if (topic === 'questions') {
      await handleQuestion(resource);
    }
  } catch (err) {
    console.error('Error procesando notificación MELI:', err.message);
  }

  return res.status(200).json({ ok: true });
};

// ── ÓRDENES ──────────────────────────────────────────────────
async function handleOrder(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const orderId = resource.replace('/orders/', '').split('/')[0];

  let order;
  try {
    const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    order = await orderRes.json();
  } catch (fetchErr) {
    console.error(`❌ fetch orden ${orderId} fallido:`, fetchErr.message, fetchErr.cause?.message || '');
    return;
  }

  // Fallback para órdenes de Mercado Shops (no accesibles por endpoint directo)
  if (order.error) {
    console.log(`⚠️ Orden ${orderId} no encontrada directo, intentando search (Shops)...`);
    try {
      const meRes = await fetch('https://api.mercadolibre.com/users/me', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const me = await meRes.json();
      const searchRes = await fetch(
        `https://api.mercadolibre.com/orders/search?seller=${me.id}&q=${orderId}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const search = await searchRes.json();
      if (search.results && search.results.length > 0) {
        order = search.results.find(o => String(o.id) === String(orderId));
      }
    } catch (fetchErr) {
      console.error(`❌ fetch fallback orden ${orderId} fallido:`, fetchErr.message, fetchErr.cause?.message || '');
      return;
    }
    if (!order || order.error) {
      console.log(`❌ Orden ${orderId} no encontrada en ningún endpoint`);
      return;
    }
    console.log(`✅ Orden ${orderId} encontrada via search (Shops)`);
  }

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

    // Verificar duplicado ANTES de tocar el stock para que reintentos de MELI no descuenten doble
    const ventaId = 'V_MELI_' + order.id + '_' + item.item.id;
    const { data: ventaExistente } = await supabase
      .from('ventas').select('id').eq('id', ventaId).single();

    if (ventaExistente) {
      console.log(`ℹ️ Venta ya existente: orden ${order.id} — omitiendo`);
      continue;
    }

    const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad);
    const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad);

    await supabase.from('productos').update({
      stock_dep: nuevoStockDep,
      stock_meli: nuevoStockMeli,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);

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
  }
}

// ── CALIFICACIONES ───────────────────────────────────────────
async function handleFeedback(resource) {
  const token = await getMeliToken();

  const feedbackId = resource.split('/').pop();
  let feedback;
  try {
    const res = await fetch(`https://api.mercadolibre.com/feedback/${feedbackId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    feedback = await res.json();
  } catch (e) { console.error('fetch feedback fallido:', e.message); return; }
  if (feedback.error) { console.log('Feedback no disponible:', feedback.message); return; }

  if (feedback.role !== 'seller') return;

  const rating = feedback.rating;
  const emoji = rating === 'positive' ? '⭐' : rating === 'negative' ? '😡' : '😐';
  const label = rating === 'positive' ? 'Positiva' : rating === 'negative' ? 'Negativa' : 'Neutral';
  const comentario = feedback.message ? `\n💬 <b>Comentario:</b> "${esc(feedback.message)}"` : '';

  await sendTelegram(
    `${emoji} <b>Nueva calificación en MELI</b>\n\n` +
    `📊 <b>Tipo:</b> ${label}\n` +
    `👤 <b>Comprador:</b> ${esc(feedback.from?.nickname || '—')}` +
    comentario
  );
}

// ── ITEMS (publicaciones pausadas / sin stock) ───────────────
async function handleItem(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const itemId = resource.split('/').pop();
  let item;
  try {
    const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    item = await res.json();
  } catch (e) { console.error('fetch item fallido:', e.message); return; }
  if (item.error) { console.log('Item no disponible:', item.message); return; }

  if (item.status !== 'paused') return;

  const { data: producto } = await supabase
    .from('productos').select('nombre, stock_dep, stock_meli').eq('meli_id', itemId).single();

  const nombre = producto?.nombre || item.title;
  const motivo = item.available_quantity === 0
    ? 'sin stock disponible'
    : 'pausada manualmente o por MELI';

  await sendTelegram(
    `🔄 <b>Publicación pausada en MELI</b>\n\n` +
    `📦 <b>Producto:</b> ${esc(nombre)}\n` +
    `🔖 <b>ID MELI:</b> ${esc(itemId)}\n` +
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
  let shipment;
  try {
    const res = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    shipment = await res.json();
  } catch (e) { console.error('fetch shipment fallido:', e.message); return; }
  if (shipment.error) {
    console.log('Shipment no disponible:', shipment.message);
    return;
  }

  if (shipment.status !== 'delivered') return;

  const orderId = String(shipment.order_id);

  const { data: envio } = await supabase
    .from('envios')
    .select('*')
    .eq('orden', orderId)
    .single();

  if (envio && envio.estado !== 'entregado') {
    await supabase.from('envios')
      .update({ estado: 'entregado' })
      .eq('id', envio.id);
    console.log(`✅ Envío marcado como entregado: orden ${orderId}`);
  }

  const comprador = envio?.comprador || shipment.receiver?.receiver_name || '—';
  const producto = envio?.producto || '—';
  const crmActualizado = envio ? '✅ CRM actualizado automáticamente.' : '⚠️ No se encontró el envío en el CRM.';

  await sendTelegram(
    `✅ <b>Envío entregado</b>\n\n` +
    `👤 <b>Comprador:</b> ${esc(comprador)}\n` +
    `📦 <b>Producto:</b> ${esc(producto)}\n` +
    `🔖 <b>Orden:</b> ${orderId}\n` +
    `🚚 <b>Tracking:</b> ${esc(envio?.tracking || shipmentId)}\n\n` +
    crmActualizado
  );
}

// ── PREGUNTAS ────────────────────────────────────────────────
async function handleQuestion(resource) {
  const token = await getMeliToken();
  const supabase = getSupabase();

  const questionId = resource.split('/').pop();
  let q;
  try {
    const res = await fetch(`https://api.mercadolibre.com/questions/${questionId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    q = await res.json();
  } catch (e) { console.error('fetch question fallido:', e.message); return; }
  if (q.error) { console.log('Pregunta no disponible:', q.message); return; }

  if (q.status !== 'UNANSWERED') return;

  let titulo = q.item_id;
  try {
    const itemRes = await fetch(`https://api.mercadolibre.com/items/${q.item_id}?attributes=title`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const item = await itemRes.json();
    titulo = item.title || q.item_id;
  } catch (e) { /* título queda como item_id */ }

  const chatId = process.env.TELEGRAM_CHAT_ID;
  await supabase.from('bot_estado').upsert({
    chat_id: chatId + '_pregunta',
    accion_pendiente: {
      tipo: 'responder_pregunta',
      question_id: q.id,
      item_id: q.item_id,
      item_titulo: titulo,
      pregunta: q.text,
      comprador: q.from?.nickname || '—',
    },
    updated_at: new Date().toISOString(),
  });

  await sendTelegram(
    `❓ <b>Nueva pregunta en MELI</b>\n\n` +
    `📦 <b>Producto:</b> ${esc(titulo)}\n` +
    `👤 <b>Comprador:</b> ${esc(q.from?.nickname || '—')}\n` +
    `💬 <b>Pregunta:</b> ${esc(q.text)}\n\n` +
    `Respondé <b>responder</b> para que Claude te sugiera una respuesta.`
  );
}
