// api/cron/telegram-cola.js
// Cron — cada 5 minutos. Manda al chat del dueño lo que quedó en telegram_cola (ver
// _telegramCola.js). Si no hay nada, no hace nada.

const { getSupabase } = require('../_supabase');
const { enviarCola } = require('../_telegramCola');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const resultados = await enviarCola(getSupabase());
    if (resultados.length) console.log('telegram-cola:', JSON.stringify(resultados));
    return res.json({ ok: true, resultados });
  } catch (err) {
    console.error('Error en telegram-cola:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
