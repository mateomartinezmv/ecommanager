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

    const campaigns = campaignsData.results || campaignsData.data || campaignsData.campaigns || [];

    if (!Array.isArray(campaigns) || campaigns.length === 0) {
      return res.json({
        ok: false,
        sin_campanas: true,
        mensaje: `La API respondió OK pero no devolvió campañas. Respuesta: ${JSON.stringify(campaignsData)}`
      });
    }

    // Base del path de advertising encontrado (sin /campaigns ni /search)
    const adsBase = `https://api.mercadolibre.com${exitoso.replace(/\/campaigns.*$/, '')}`;

    // 4. DEBUG: intentar métricas del primer campaign y devolver todo para diagnóstico
    const primerCampaign = campaigns[0];
    const primerCampaignId = String(primerCampaign.id || primerCampaign.campaign_id || '');
    const metricsCandidatos = [
      `${adsBase}/campaigns/${primerCampaignId}/metrics/daily?date_from=${dateFrom}&date_to=${dateTo}`,
      `${adsBase}/campaigns/${primerCampaignId}/metrics?date_from=${dateFrom}&date_to=${dateTo}`,
      `${adsBase}/reports/daily?campaign_id=${primerCampaignId}&date_from=${dateFrom}&date_to=${dateTo}`,
      `${adsBase}/reports?campaign_id=${primerCampaignId}&date_from=${dateFrom}&date_to=${dateTo}`,
    ];
    const metricsProbes = {};
    for (const url of metricsCandidatos) {
      const r = await fetch(url, { headers });
      metricsProbes[url] = { status: r.status, body: await r.json().catch(() => ({})) };
    }

    return res.json({
      ok: false,
      debug: true,
      path_campaigns_exitoso: exitoso,
      campaigns_raw: campaignsData,
      primer_campaign: primerCampaign,
      metrics_probes: metricsProbes
    });

  } catch (err) {
    console.error('Error en ads.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
