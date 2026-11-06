// api/_aviso.js
// Avisos al dueño por WhatsApp (Kapso). Si Kapso no está configurado, o el envío
// falla, cae a Telegram para que un aviso importante no se pierda en silencio.
//
// Env vars:
//   KAPSO_API_KEY            API key del proyecto en Kapso
//   KAPSO_PHONE_NUMBER_ID    ID del número de WhatsApp Business conectado a Kapso
//   WHATSAPP_TO              tu WhatsApp personal, sólo dígitos con código de país (ej. 59899123456)
//   KAPSO_WABA_ID            ID de la cuenta de WhatsApp Business (sólo para crear la plantilla)
//   KAPSO_TEMPLATE_NAME      (opcional) plantilla aprobada con UNA variable {{1}} en el cuerpo,
//                            para cuando la ventana de 24 h está cerrada. La crea
//                            POST /api/whatsapp/setup?accion=plantilla
//   KAPSO_TEMPLATE_LANG      (opcional) idioma de la plantilla, por defecto es
//
// Ojo con la ventana de 24 h de WhatsApp: el texto libre sólo llega si le escribiste al
// número del negocio en las últimas 24 h. Fuera de eso hace falta la plantilla.

const KAPSO_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const PLANTILLA_POR_DEFECTO = 'aviso_ecommanager';

// Los avisos se escriben en HTML de Telegram; WhatsApp usa *negrita*.
function htmlAWhatsapp(html) {
  return String(html ?? '')
    .replace(/<\/?b>/g, '*')
    .replace(/<\/?i>/g, '_')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function enviarTelegram(html) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error(`Telegram HTTP ${res.status}:`, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (err) {
    console.error('Telegram error:', err.message);
    return false;
  }
}

async function kapsoPost(body) {
  const res = await fetch(`${KAPSO_BASE}/${process.env.KAPSO_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.KAPSO_API_KEY },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: process.env.WHATSAPP_TO, ...body }),
  });
  if (!res.ok) console.error(`Kapso HTTP ${res.status}:`, (await res.text()).slice(0, 300));
  return res.ok;
}

async function enviarWhatsapp(html) {
  const { KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, WHATSAPP_TO, KAPSO_TEMPLATE_NAME } = process.env;
  if (!KAPSO_API_KEY || !KAPSO_PHONE_NUMBER_ID || !WHATSAPP_TO) return false;
  const texto = htmlAWhatsapp(html);
  try {
    // Dentro de la ventana de 24 h (tu último mensaje al número del negocio) va texto libre.
    if (await kapsoPost({ type: 'text', text: { body: texto } })) return true;
    if (!KAPSO_TEMPLATE_NAME) return false;
    // Fuera de la ventana sólo se puede mandar una plantilla. Meta no admite saltos de
    // línea ni más de 3 espacios seguidos en una variable, así que se aplana.
    const plano = texto.replace(/\s*\n+\s*/g, ' · ').replace(/ {2,}/g, ' ').slice(0, 900);
    return await kapsoPost({
      type: 'template',
      template: {
        name: KAPSO_TEMPLATE_NAME,
        language: { code: process.env.KAPSO_TEMPLATE_LANG || 'es' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: plano }] }],
      },
    });
  } catch (err) {
    console.error('Kapso error:', err.message, err.cause?.message || '');
    return false;
  }
}

// Aviso normal: WhatsApp, y si no se pudo, Telegram.
async function enviarAviso(html) {
  if (await enviarWhatsapp(html)) return true;
  return enviarTelegram(html);
}

module.exports = { enviarAviso, enviarWhatsapp, enviarTelegram, htmlAWhatsapp, KAPSO_BASE, PLANTILLA_POR_DEFECTO };
