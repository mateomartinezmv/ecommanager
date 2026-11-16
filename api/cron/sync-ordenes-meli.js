// api/cron/sync-ordenes-meli.js
// Cron — cada 2 horas. Registra las ventas de MELI cuyo aviso se perdió (ver _syncOrdenes.js).
// Reemplaza a la Edge Function de Supabase sync-meli-orders.

const { getSupabase } = require('../_supabase');
const { getMeliToken } = require('../_meliToken');
const { invocar } = require('../_invocar');
const { sincronizarOrdenes, ordenesPagadasRecientes } = require('../_syncOrdenes');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getMeliToken();
    const notify = require('../meli/notify');
    const r = await sincronizarOrdenes(getSupabase(), {
      listar: () => ordenesPagadasRecientes(token),
      procesar: (id) => invocar(notify, { method: 'POST', body: { topic: 'orders_v2', resource: `/orders/${id}` } }),
    });
    const nuevas = r.procesadas.filter(p => p.registrada).length;
    console.log(`sync-ordenes-meli: ${r.revisadas} revisadas, ${r.ya_estaban} ya estaban, ${nuevas} registradas ahora, ${r.procesadas.length - nuevas} sin registrar`);
    return res.json({ ok: true, ...r });
  } catch (err) {
    console.error('Error en sync-ordenes-meli:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
