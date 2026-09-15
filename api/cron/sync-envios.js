// api/cron/sync-envios.js
// Cron — cada 30 minutos.
//
// Red de contención del webhook de `shipments`: si MELI no notifica (o la
// notificación falla), los envíos quedarían congelados en "pendiente" aunque el
// paquete ya esté en camino o entregado. Acá se vuelve a preguntar por los
// envíos que todavía no llegaron.

const { sincronizarEnviosMeli } = require('../meli/sync-envios');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // limit 60: dos llamadas a MELI por orden entran holgadas en los 60s de la
    // función, y la cola real de envíos abiertos es de una decena.
    const r = await sincronizarEnviosMeli({ dias: 45, limit: 60 });
    console.log(`sync-envios: ${r.actualizados} actualizados | ${r.sinCambio} sin cambio | ${r.errores} errores`);
    for (const linea of r.log) console.log(linea);
    return res.json({
      ok: true,
      actualizados: r.actualizados,
      sinCambio: r.sinCambio,
      errores: r.errores,
      cambios: r.cambios,
    });
  } catch (err) {
    console.error('Error en sync-envios.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
