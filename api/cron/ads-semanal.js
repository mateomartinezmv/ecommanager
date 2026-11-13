// api/cron/ads-semanal.js
// Cron — los lunes, una invocación por parte (?parte=campanas|anuncios|recomendaciones|
// promos|cambios), separadas por 5 minutos en vercel.json.
//
// Junta los datos de la semana cerrada para la revisión semanal de MELI Ads y promos que
// hace la tarea programada de Claude (ver _adsRevision.js). No aplica nada ni avisa: sólo
// guarda en ads_revision_partes.

const { getSupabase } = require('../_supabase');
const { correrParte } = require('../_adsRevision');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parte = String(req.query?.parte || '');
  try {
    const r = await correrParte(getSupabase(), parte);
    console.log(`ads-semanal ${r.semana} ${parte}: ${r.ok ? 'ok' : `con errores: ${r.error}`}`);
    return res.json({ ok: true, ...r });
  } catch (err) {
    console.error(`Error en ads-semanal (${parte}):`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
