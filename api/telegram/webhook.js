// api/telegram/webhook.js
// Lo que llega desde el chat del bot.
//
// El bot ya no atiende comandos ni texto libre (stock, ventas, ganancia, recomendaciones,
// cargar ventas o despachos escribiendo): todo eso se hace desde el CRM. Lo único que queda
// son los botones ✅ Aceptar / ❌ Rechazar de las preguntas de MELI (ver
// _telegramPreguntas.js).
//
// Para que Telegram mande los toques de botón (callback_query) el webhook tiene que estar
// registrado con ese tipo de update: se hace abriendo /api/telegram/setup una vez.

const { getSupabase } = require('../_supabase');
const { enviar } = require('../_telegram');
const { resolverBoton } = require('../_telegramPreguntas');

const AYUDA =
  '🏍️ <b>Asistente de Martinez Motos</b>\n\n' +
  'Este bot sólo avisa. Te llegan:\n' +
  '❓ Preguntas de MELI con la respuesta lista: tocás <b>✅ Aceptar</b> o <b>❌ Rechazar</b>.\n' +
  '⚠️ Ventas de publicaciones sin vincular al CRM.\n' +
  '📦 Publicaciones cuyo stock no se pudo corregir.\n' +
  '📣 Lo que se publica en Instagram y Facebook.\n' +
  '📊 El resumen del día a las 20:00.\n' +
  '📈 La revisión semanal de Ads, los lunes a la tarde.\n' +
  '🔍 La auditoría de publicaciones, los días 1 y 15.\n\n' +
  'Lo demás se maneja desde el CRM.';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const miChat = String(process.env.TELEGRAM_CHAT_ID || '');
  const callback = req.body?.callback_query;
  const message = req.body?.message;

  try {
    if (callback) {
      // Sólo el chat del dueño puede publicar respuestas en MELI.
      if (String(callback.message?.chat?.id) !== miChat) return res.status(200).json({ ok: true });
      const r = await resolverBoton(getSupabase(), callback);
      console.log(`Botón ${callback.data}: ${r.estado}`);
    } else if (message?.text && String(message.chat?.id) === miChat) {
      await enviar(AYUDA);
    }
  } catch (err) {
    console.error('Error en webhook Telegram:', err.message);
  }

  // Siempre 200: si no, Telegram reintenta el mismo update en loop.
  return res.status(200).json({ ok: true });
};
