// api/telegram/setup.js
// GET /api/telegram/setup → verifica configuración y registra webhook
// POST /api/telegram/setup → envía mensaje de prueba

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.json({
      ok: false,
      error: 'Faltan env vars: TELEGRAM_BOT_TOKEN y/o TELEGRAM_CHAT_ID',
      tiene_token: !!token,
      tiene_chat_id: !!chatId,
    });
  }

  const baseUrl = `https://api.telegram.org/bot${token}`;

  // Verificar que el bot existe
  let botInfo = null;
  try {
    const meRes = await fetch(`${baseUrl}/getMe`);
    botInfo = await meRes.json();
  } catch (e) {
    return res.json({ ok: false, error: 'fetch failed al llamar getMe', detalle: e.message });
  }

  if (!botInfo.ok) {
    return res.json({ ok: false, error: 'Token inválido', telegram: botInfo });
  }

  // Registrar webhook. callback_query = los toques de los botones Aceptar / Rechazar de las
  // preguntas de MELI: sin eso en la lista, Telegram no los manda y los botones no hacen nada.
  const webhookUrl = `https://ecommanager.vercel.app/api/telegram/webhook`;
  let webhookResult = null;
  try {
    const whRes = await fetch(`${baseUrl}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
    });
    webhookResult = await whRes.json();
  } catch (e) {
    webhookResult = { error: e.message };
  }

  // Enviar mensaje de prueba
  let testResult = null;
  try {
    const testRes = await fetch(`${baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ <b>Bot configurado correctamente</b>\n\nLas preguntas de MELI te van a llegar con la respuesta lista y los botones ✅ Aceptar / ❌ Rechazar.',
        parse_mode: 'HTML',
      }),
    });
    testResult = await testRes.json();
  } catch (e) {
    testResult = { error: e.message };
  }

  return res.json({
    ok: true,
    bot: { username: botInfo.result?.username, id: botInfo.result?.id },
    webhook: { url: webhookUrl, resultado: webhookResult?.ok ? 'registrado' : webhookResult },
    mensaje_prueba: testResult?.ok ? 'enviado ✅' : testResult,
    chat_id_usado: chatId,
  });
};
