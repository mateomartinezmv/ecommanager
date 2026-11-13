// api/_telegram.js
// Lo único que el sistema le manda al chat del dueño, en un solo lugar.
//
// Los mensajes van con parse_mode HTML: todo texto que venga de afuera (preguntas de
// compradores, títulos de publicaciones, errores de MELI) pasa por esc() o Telegram rechaza
// el mensaje entero.

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Llama a un método de la Bot API. Devuelve `result` o null si no se pudo: un aviso que no
// sale nunca tiene que tirar abajo lo que lo disparó (una venta, una pregunta).
async function telegram(metodo, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      console.error(`Telegram ${metodo} HTTP ${res.status}:`, JSON.stringify(data).slice(0, 200));
      return null;
    }
    return data.result;
  } catch (err) {
    console.error(`Telegram ${metodo}:`, err.message, err.cause?.message || '');
    return null;
  }
}

// botones: [[{ text, callback_data }, ...], ...] — una fila por array.
// html: false manda el texto tal cual (sin parse_mode): sirve de respaldo cuando un texto
// que no armó el sistema trae HTML que Telegram rechaza.
async function enviar(texto, { botones, html = true } = {}) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return null;
  return telegram('sendMessage', {
    chat_id: chatId,
    text: texto,
    ...(html ? { parse_mode: 'HTML' } : {}),
    ...(botones ? { reply_markup: { inline_keyboard: botones } } : {}),
  });
}

// Reemplaza el texto de un mensaje ya enviado. Sin `botones`, los saca: así un aviso que ya
// se resolvió no queda con un "Aceptar" que se puede volver a tocar.
async function editar(messageId, texto, { botones } = {}) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId || !messageId) return null;
  return telegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: texto,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: botones || [] },
  });
}

// Corta el relojito del botón tocado. Con `texto`, muestra un cartel arriba del chat.
async function responderBoton(callbackId, texto) {
  return telegram('answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(texto ? { text: texto, show_alert: false } : {}),
  });
}

module.exports = { esc, telegram, enviar, editar, responderBoton };
