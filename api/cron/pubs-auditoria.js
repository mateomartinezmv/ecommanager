// api/cron/pubs-auditoria.js
// Cron — los días 1 y 15, una invocación por parte (?parte=conversion|angulos|fotos|
// publicaciones|preguntas), separadas por 5 minutos en vercel.json. `publicaciones` usa la
// conversión que guardó `conversion` ese mismo día, así que va después.
//
// Junta los datos de la auditoría quincenal de publicaciones de MELI que hace la tarea
// programada de Claude (ver _auditoriaPubs.js). No cambia nada en MELI: sólo guarda en
// pubs_auditoria_partes.

const { getSupabase } = require('../_supabase');
const { correrParte } = require('../_auditoriaPubs');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parte = String(req.query?.parte || '');
  try {
    const r = await correrParte(getSupabase(), parte);
    console.log(`pubs-auditoria ${r.fecha} ${parte}: ${r.ok ? 'ok' : `con errores: ${r.error}`}`);
    return res.json({ ok: true, ...r });
  } catch (err) {
    console.error(`Error en pubs-auditoria (${parte}):`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
