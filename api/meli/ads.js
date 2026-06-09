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
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Obtener usuario
    const meRes = await fetch('https://api.mercadolibre.com/users/me', { headers });
    const me = await meRes.json();
    if (!me.id) return res.json({ ok: false, error: 'No se pudo obtener el usuario MELI' });

    const userId = me.id;

    // 2. Resolver advertiser_id (requiere product_id=PADS en todos los calls de advertising)
    let advertiserId = userId;
    const advertiserSearchRes = await fetch(
      `https://api.mercadolibre.com/advertising/advertisers?user_id=${userId}&product_id=PADS`,
      { headers }
    );
    const advertiserSearchData = await advertiserSearchRes.json();
    if (advertiserSearchRes.ok && advertiserSearchData.advertisers?.length > 0) {
      advertiserId = advertiserSearchData.advertisers[0].advertiser_id;
    }

    // 3. Probar paths de campañas con la estructura marketplace/advertising
    const siteId = advertiserSearchData.advertisers?.[0]?.site_id || 'MLU';
    const candidatos = [
      `/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search`,
      `/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns`,
      `/marketplace/advertising/${siteId}/product_ads/campaigns?advertiser_id=${advertiserId}`,
      `/marketplace/advertising/${advertiserId}/product_ads/campaigns`,
    ];
    const probes = {};
    for (const path of candidatos) {
      const r = await fetch(`https://api.mercadolibre.com${path}`, { headers });
      probes[path] = { status: r.status, body: await r.json().catch(() => ({})) };
    }
    const exitoso = candidatos.find(p => probes[p].status === 200);
    if (!exitoso) {
      return res.json({
        ok: false,
        error: 'Ningún path de campañas devolvió 200',
        detalle: probes
      });
    }
    const campaignsData = probes[exitoso].body;

    const campaigns = campaignsData.results || campaignsData.data || [];

    if (!Array.isArray(campaigns) || campaigns.length === 0) {
      return res.json({
        ok: false,
        sin_campanas: true,
        mensaje: `La API respondió OK pero no devolvió campañas. Respuesta: ${JSON.stringify(campaignsData)}`
      });
    }

    // 4. Obtener métricas diarias por campaña y guardar en Supabase
    let totalSpend = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    const porCampana = [];

    for (const campaign of campaigns) {
      const campaignId = String(campaign.id);
      const campaignName = campaign.name || campaign.title || campaignId;

      const metricsRes = await fetch(
        `https://api.mercadolibre.com/advertising/advertisers/${advertiserId}/campaigns/${campaignId}/metrics/daily?product_id=PADS&date_from=${dateFrom}&date_to=${dateTo}`,
        { headers }
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
          { fecha, campaign_id: campaignId, campaign_name: campaignName, spend, clicks, impressions, currency, fetched_at: new Date().toISOString() },
          { onConflict: 'fecha,campaign_id' }
        );
      }

      totalSpend += campSpend;
      totalClicks += campClicks;
      totalImpressions += campImpressions;
      porCampana.push({ campaign_id: campaignId, campaign_name: campaignName, spend: campSpend, clicks: campClicks, impressions: campImpressions });
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
