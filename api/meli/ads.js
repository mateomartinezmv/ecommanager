// api/meli/ads.js
// GET /api/meli/ads?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Llama a campaigns/search con date_from+date_to; MELI devuelve métricas
// (cost, clicks, prints) agregadas por período en la misma respuesta.

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

    // 2. Resolver advertiser_id y site_id
    const advertiserRes = await fetch(
      `https://api.mercadolibre.com/advertising/advertisers?user_id=${me.id}&product_id=PADS`,
      { headers }
    );
    const advertiserData = await advertiserRes.json();

    if (!advertiserRes.ok || !advertiserData.advertisers?.length) {
      return res.json({ ok: false, sin_acceso: true, mensaje: 'No se encontró perfil de anunciante en MELI Ads.' });
    }

    const { advertiser_id: advertiserId, site_id: siteId } = advertiserData.advertisers[0];

    // 3. Obtener campañas CON métricas del período en un solo call
    // MELI devuelve cost, clicks, prints cuando se pasan date_from y date_to
    const campaignsRes = await fetch(
      `https://api.mercadolibre.com/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search?date_from=${dateFrom}&date_to=${dateTo}`,
      { headers }
    );
    const campaignsData = await campaignsRes.json();

    if (!campaignsRes.ok) {
      const status = campaignsRes.status;
      if (status === 401 || status === 403) {
        return res.json({
          ok: false,
          sin_acceso: true,
          mensaje: `Sin acceso a la API de Advertising (HTTP ${status}). Habilitá el scope en developers.mercadolibre.com.uy → tu app → Scopes → Advertising.`
        });
      }
      return res.json({ ok: false, error: `Error ${status} consultando campañas`, detalle: campaignsData });
    }

    const campaigns = campaignsData.results || campaignsData.data || campaignsData.campaigns || [];

    if (!Array.isArray(campaigns) || campaigns.length === 0) {
      return res.json({ ok: false, sin_campanas: true, mensaje: 'La API respondió OK pero no devolvió campañas.' });
    }

    // 4. Extraer métricas (cost/clicks/prints) y guardar en Supabase
    // Las métricas pueden estar anidadas en campaign.metrics o al nivel del campaign
    let totalSpend = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    const porCampana = [];

    for (const campaign of campaigns) {
      const campaignId = String(campaign.id || campaign.campaign_id);
      const campaignName = campaign.name || campaign.campaign_name || campaignId;
      const m = campaign.metrics || campaign;

      const spend = parseFloat(m.cost || m.spend || m.investment || 0);
      const clicks = parseInt(m.clicks || 0, 10);
      const impressions = parseInt(m.prints || m.impressions || 0, 10);

      totalSpend += spend;
      totalClicks += clicks;
      totalImpressions += impressions;
      porCampana.push({ campaign_id: campaignId, campaign_name: campaignName, spend, clicks, impressions });

      // Upsert con fecha=dateTo (agregado por período, un registro por campaña)
      await supabase.from('meli_ads_gastos').upsert(
        {
          fecha: dateTo,
          campaign_id: campaignId,
          campaign_name: campaignName,
          spend,
          clicks,
          impressions,
          currency: me.currency_id || 'UYU',
          fetched_at: new Date().toISOString()
        },
        { onConflict: 'fecha,campaign_id' }
      );
    }

    // Si spend = 0, las métricas no vienen en campaigns/search — probar endpoints alternativos
    if (totalSpend === 0 && campaigns.length > 0) {
      const base = `https://api.mercadolibre.com/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads`;
      const cid = String(campaigns[0].id || campaigns[0].campaign_id);
      const dq = `date_from=${dateFrom}&date_to=${dateTo}`;
      const metricsAlts = {};

      const altUrls = [
        { key: 'GET campaign single', url: `${base}/campaigns/${cid}?${dq}`, method: 'GET' },
        { key: 'GET summary', url: `${base}/summary?${dq}`, method: 'GET' },
        { key: 'GET items', url: `${base}/items?campaign_id=${cid}&${dq}`, method: 'GET' },
        { key: 'GET campaigns search + include_metrics', url: `${base}/campaigns/search?${dq}&include=metrics`, method: 'GET' },
        { key: 'POST campaigns search with body', url: `${base}/campaigns/search`, method: 'POST', body: JSON.stringify({ date_from: dateFrom, date_to: dateTo }) },
      ];

      for (const alt of altUrls) {
        const opts = { method: alt.method, headers: { ...headers, 'Content-Type': 'application/json' } };
        if (alt.body) opts.body = alt.body;
        const r = await fetch(alt.url, opts);
        metricsAlts[alt.key] = { status: r.status, body: JSON.stringify(await r.json().catch(() => ({}))).slice(0, 500) };
      }

      return res.json({
        ok: false,
        error: 'campaigns/search no incluye métricas. Ver alternativas.',
        detalle: metricsAlts
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
