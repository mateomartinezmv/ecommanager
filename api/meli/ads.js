// api/meli/ads.js
// GET /api/meli/ads?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Consulta campañas y métricas de MELI Ads y las cachea en Supabase.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const now = new Date();
  const primerDiaMes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const hoy = now.toISOString().slice(0, 10);
  const dateFrom = req.query.desde || primerDiaMes;
  const dateTo = req.query.hasta || hoy;

  try {
    let token;
    try {
      token = await getMeliToken();
    } catch {
      return res.json({ ok: false, error: 'MELI no conectado' });
    }

    const supabase = getSupabase();

    // 1. Obtener usuario
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const me = await meRes.json();
    if (!me.id) return res.json({ ok: false, error: 'No se pudo obtener el usuario MELI' });

    const userId = me.id;

    // 2. Obtener campañas
    const campaignsRes = await fetch(
      `https://api.mercadolibre.com/advertising/advertisers/${userId}/campaigns?limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const campaignsData = await campaignsRes.json();

    if (!campaignsRes.ok) {
      const status = campaignsRes.status;
      if (status === 401 || status === 403) {
        return res.json({
          ok: false,
          sin_acceso: true,
          mensaje: `La app no tiene acceso a la API de Advertising (HTTP ${status}). Habilitá el scope en developers.mercadolibre.com.uy → tu app → Scopes → Advertising.`,
          detalle: campaignsData
        });
      }
      return res.json({
        ok: false,
        error: `Error ${status} consultando campañas de MELI Ads`,
        detalle: campaignsData
      });
    }

    const campaigns = campaignsData.results || campaignsData.data || [];

    if (!Array.isArray(campaigns) || campaigns.length === 0) {
      return res.json({
        ok: false,
        sin_campanas: true,
        mensaje: `MELI no devolvió campañas. Respuesta: ${JSON.stringify(campaignsData)}`,
        por_campana: [],
        periodo: { desde: dateFrom, hasta: dateTo }
      });
    }

    // 3. Obtener métricas diarias por campaña y guardar en Supabase
    let totalSpend = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    const porCampana = [];

    for (const campaign of campaigns) {
      const campaignId = String(campaign.id);
      const campaignName = campaign.name || campaign.title || campaignId;

      const metricsRes = await fetch(
        `https://api.mercadolibre.com/advertising/advertisers/${userId}/campaigns/${campaignId}/metrics/daily?date_from=${dateFrom}&date_to=${dateTo}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!metricsRes.ok) continue;

      const metricsData = await metricsRes.json();
      const days = metricsData.results || metricsData.data || [];

      let campSpend = 0;
      let campClicks = 0;
      let campImpressions = 0;

      for (const day of days) {
        const fecha = day.date || day.fecha;
        if (!fecha) continue;

        const spend = parseFloat(day.spend || day.cost || day.investment || 0);
        const clicks = parseInt(day.clicks || 0, 10);
        const impressions = parseInt(day.impressions || day.prints || 0, 10);
        const currency = day.currency || me.currency_id || 'UYU';

        campSpend += spend;
        campClicks += clicks;
        campImpressions += impressions;

        await supabase.from('meli_ads_gastos').upsert(
          {
            fecha,
            campaign_id: campaignId,
            campaign_name: campaignName,
            spend,
            clicks,
            impressions,
            currency,
            fetched_at: new Date().toISOString()
          },
          { onConflict: 'fecha,campaign_id' }
        );
      }

      totalSpend += campSpend;
      totalClicks += campClicks;
      totalImpressions += campImpressions;

      porCampana.push({
        campaign_id: campaignId,
        campaign_name: campaignName,
        spend: campSpend,
        clicks: campClicks,
        impressions: campImpressions
      });
    }

    return res.json({
      ok: true,
      total_spend: totalSpend,
      clicks: totalClicks,
      impressions: totalImpressions,
      por_campana: porCampana,
      periodo: { desde: dateFrom, hasta: dateTo }
    });

  } catch (err) {
    console.error('Error en ads.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
