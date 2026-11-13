// api/cron/sync-stock-pubs.js
// Cron — cada hora.
//
// Red de contención del stock cuando un producto tiene varias publicaciones. El CRM ya las
// sincroniza en el momento (al editar el producto, al entrar una venta), pero eso sólo cubre
// lo que pasa por el CRM: una publicación creada aparte, un PUT que MELI rechazó, un cambio
// hecho a mano desde MELI o una venta cuya notificación se perdió dejan a una publicación
// vendiendo con un stock que ya no existe. Acá se compara contra la API y se corrige.
//
// Corrige en silencio. Sólo avisa por Telegram cuando una misma publicación no se pudo
// corregir varias horas seguidas (ver _fallosStock.js), y de cada una avisa una sola vez.

const { conciliarStock } = require('../meli/stock');
const { getSupabase } = require('../_supabase');
const { registrarFallos, VECES_PARA_AVISAR } = require('../_fallosStock');
const { esc, enviar } = require('../_telegram');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const r = await conciliarStock();
    console.log(`sync-stock-pubs: ${r.publicaciones} publicaciones de ${r.productos} productos | ${r.desincronizadas} desincronizadas | ${r.sincronizadas} corregidas | ${r.fallidas.length} fallidas`);

    const avisar = await registrarFallos(getSupabase(), r.fallidas);
    if (avisar.length) {
      const lineas = avisar.slice(0, 10).map(f =>
        `· <b>${esc(f.sku || '—')}</b> (${esc(f.meli_id)})${f.titulo ? ` ${esc(f.titulo)}` : ''}\n  ${esc(f.error)}`
      ).join('\n');
      const mas = avisar.length > 10 ? `\n… y ${avisar.length - 10} más.` : '';
      await enviar(
        `⚠️ <b>Stock de MELI sin poder corregir</b>\n\n` +
        `Hace ${VECES_PARA_AVISAR} horas que ${avisar.length === 1 ? 'esta publicación tiene' : 'estas publicaciones tienen'} ` +
        `un stock distinto al del CRM y MELI rechaza la corrección:\n\n${lineas}${mas}\n\n` +
        `Revisalo en MELI. De cada una te aviso una sola vez: si se arregla y vuelve a fallar, el conteo arranca de nuevo.`
      );
    }

    return res.json({ ok: true, ...r, avisadas: avisar.length });
  } catch (err) {
    console.error('Error en sync-stock-pubs.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
