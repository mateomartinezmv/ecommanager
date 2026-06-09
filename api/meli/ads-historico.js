// api/meli/ads-historico.js
// GET /api/meli/ads-historico?dias=30
// Lee el gasto de Ads desde Supabase (caché local, sin llamar a MELI).

const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const dias = parseInt(req.query.dias || '30', 10);
  const cutoff = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);

  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('meli_ads_gastos')
      .select('fecha, spend, clicks, impressions')
      .gte('fecha', cutoff)
      .order('fecha', { ascending: true });

    if (error) throw error;

    const rows = data || [];

    // Agrupar por día sumando todas las campañas
    const porDiaMap = {};
    for (const row of rows) {
      if (!porDiaMap[row.fecha]) {
        porDiaMap[row.fecha] = { fecha: row.fecha, spend: 0, clicks: 0, impressions: 0 };
      }
      porDiaMap[row.fecha].spend += parseFloat(row.spend || 0);
      porDiaMap[row.fecha].clicks += parseInt(row.clicks || 0, 10);
      porDiaMap[row.fecha].impressions += parseInt(row.impressions || 0, 10);
    }

    const porDia = Object.values(porDiaMap).sort((a, b) => a.fecha.localeCompare(b.fecha));
    const total_spend = porDia.reduce((a, d) => a + d.spend, 0);
    const total_clicks = porDia.reduce((a, d) => a + d.clicks, 0);
    const total_impressions = porDia.reduce((a, d) => a + d.impressions, 0);

    return res.json({
      total_spend,
      clicks: total_clicks,
      impressions: total_impressions,
      dias_con_datos: porDia.length,
      por_dia: porDia
    });

  } catch (err) {
    console.error('Error en ads-historico.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
