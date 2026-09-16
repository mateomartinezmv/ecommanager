// api/cron/sync-stock-pubs.js
// Cron — cada 4 horas.
//
// Red de contención del stock cuando un producto tiene varias publicaciones. El CRM ya las
// sincroniza en el momento (al editar el producto, al entrar una venta), pero eso sólo cubre
// lo que pasa por el CRM: una publicación creada aparte, un PUT que MELI rechazó, un cambio
// hecho a mano desde MELI o una venta cuya notificación se perdió dejan a una publicación
// vendiendo con un stock que ya no existe. Acá se compara contra la API y se corrige.
//
// Sólo avisa por Telegram si hubo algo que corregir o algo que falló: si está todo al día no
// molesta.

const { conciliarStock } = require('../meli/stock');

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

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const r = await conciliarStock();
    console.log(`sync-stock-pubs: ${r.publicaciones} publicaciones de ${r.productos} productos | ${r.desincronizadas} desincronizadas | ${r.sincronizadas} corregidas | ${r.fallidas.length} fallidas`);

    if (r.sincronizadas || r.fallidas.length) {
      const fallos = r.fallidas.length
        ? `\n\n❌ <b>No se pudieron:</b>\n${r.fallidas.slice(0, 10).map(f => `· ${esc(f.sku)} (${esc(f.meli_id)}): ${esc(f.error)}`).join('\n')}`
        : '';
      await sendTelegram(
        `📦 <b>Stock de publicaciones corregido</b>\n\n` +
        `Se encontraron <b>${r.desincronizadas}</b> publicaciones con un stock distinto al del CRM ` +
        `y se corrigieron <b>${r.sincronizadas}</b>.${fallos}`
      );
    }

    return res.json({ ok: true, ...r });
  } catch (err) {
    console.error('Error en sync-stock-pubs.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
