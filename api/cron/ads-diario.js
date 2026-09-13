// api/cron/ads-diario.js
// Cron — 14:00 UTC (11:00 Uruguay), después de que MELI consolida las métricas del día
// anterior a las 10:00 GMT-3.
//
// Vuelve a pedir los últimos 8 días en lugar de sólo ayer: MELI sigue ajustando las
// métricas de los días recientes, y como la fecha es la clave primaria, re-pedirlas
// corrige los valores en lugar de duplicarlos.
//
// Este cron es lo que sostiene el histórico: MELI sólo sirve 90 días hacia atrás, así que
// un día que no se capture dentro de esa ventana se pierde de forma definitiva.

const DIAS_A_REFRESCAR = 8;

module.exports = async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
  if (!base) return res.status(500).json({ ok: false, error: 'Falta VERCEL_URL' });

  try {
    const r = await fetch(`${base}/api/meli/ads?dias=${DIAS_A_REFRESCAR}`);
    const data = await r.json();

    if (!data.ok) {
      console.error('ads-diario: la captura falló:', data.error || data.mensaje);
      return res.status(200).json({ ok: false, error: data.error || data.mensaje });
    }

    console.log(`ads-diario: ${data.dias_guardados} días guardados, gasto ${data.total_spend}`);
    return res.json({
      ok: true,
      dias_guardados: data.dias_guardados,
      periodo: data.periodo,
      total_spend: data.total_spend,
    });
  } catch (err) {
    console.error('Error en ads-diario.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
