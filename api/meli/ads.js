// api/meli/ads.js
// GET /api/meli/ads?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Llama a /marketplace/advertising/{site_id}/advertisers/{id}/product_ads/campaigns/search
// con métricas por campaña. Los campos correctos son: metrics.cost, metrics.clicks, metrics.prints

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const METRICS_FIELDS = 'clicks,prints,cost,cpc,acos,cvr,roas,ctr,direct_amount,indirect_amount,total_amount';

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
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const headersAdvertisers = { ...headers, 'Api-Version': '1' };
    const headersAds = { ...headers, 'Api-Version': '2' };

    // 1. Obtener usuario
    const meRes = await fetch('https://api.mercadolibre.com/users/me', { headers });
    const me = await meRes.json();
    if (!me.id) return res.json({ ok: false, error: 'No se pudo obtener el usuario MELI' });

    // 2. Resolver advertiser_id y site_id
    const advRes = await fetch(
      `https://api.mercadolibre.com/advertising/advertisers?user_id=${me.id}&product_id=PADS`,
      { headers: headersAdvertisers }
    );
    const advData = await advRes.json();
    if (!advRes.ok || !advData.advertisers?.length) {
      return res.json({ ok: false, sin_acceso: true, mensaje: 'No se encontró perfil de anunciante en MELI Ads.' });
    }
    const { advertiser_id: advertiserId, site_id: siteId } = advData.advertisers[0];

    // 3. Obtener campañas con métricas del período — paginado hasta agotar resultados
    // OJO: el endpoint sin el prefijo /marketplace/{site_id}/ quedó legacy y devuelve 404
    // vacío para campañas creadas después de la migración de MELI (~jul/2026), incluso
    // con campañas activas. Este es el endpoint vigente.
    const base = `https://api.mercadolibre.com/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search`;
    const allCampaigns = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const url = `${base}?date_from=${dateFrom}&date_to=${dateTo}&metrics=${METRICS_FIELDS}&limit=${limit}&offset=${offset}`;
      const r = await fetch(url, { headers: headersAds });
      const text = await r.text();
      let body = {};
      if (text) {
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
      }

      if (!r.ok) {
        if (r.status === 404) {
          return res.json({
            ok: false,
            sin_campanas: true,
            mensaje: 'Mercado Libre no devolvió datos de campañas para este período.'
          });
        }
        return res.json({
          ok: false,
          error: `Error ${r.status} al obtener campañas de MELI Ads`,
          detalle: body
        });
      }

      const rows = body.results || [];
      allCampaigns.push(...rows);

      const total = body.paging?.total ?? rows.length;
      if (allCampaigns.length >= total || rows.length < limit) break;
      offset += limit;
    }

    if (allCampaigns.length === 0) {
      return res.json({ ok: true, total_spend: 0, clicks: 0, impressions: 0, por_campana: [], items_procesados: 0, periodo: { desde: dateFrom, hasta: dateTo } });
    }

    // 4. Agregar por campaña y guardar en Supabase
    const porCampana = {};
    for (const camp of allCampaigns) {
      const cid = String(camp.id);
      const m = camp.metrics || {};
      const spend = parseFloat(m.cost || 0);
      const clicks = parseInt(m.clicks || 0, 10);
      const impressions = parseInt(m.prints || 0, 10);
      const facturacion = parseFloat(m.total_amount || 0);

      porCampana[cid] = {
        campaign_id: cid,
        campaign_name: camp.name || cid,
        status: camp.status,
        spend,
        clicks,
        impressions,
        facturacion,
        roas: spend > 0 ? parseFloat((facturacion / spend).toFixed(2)) : 0,
      };
    }

    const currency = me.currency_id || 'UYU';
    for (const c of Object.values(porCampana)) {
      await supabase.from('meli_ads_gastos').upsert(
        {
          fecha: dateFrom,
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          spend: c.spend,
          clicks: c.clicks,
          impressions: c.impressions,
          roas: c.roas,
          facturacion: c.facturacion,
          currency,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'fecha,campaign_id' }
      );
    }

    const totalSpend = Object.values(porCampana).reduce((s, c) => s + c.spend, 0);
    const totalClicks = Object.values(porCampana).reduce((s, c) => s + c.clicks, 0);
    const totalImpressions = Object.values(porCampana).reduce((s, c) => s + c.impressions, 0);
    const totalFact = Object.values(porCampana).reduce((s, c) => s + c.facturacion, 0);
    const roasTotal = totalSpend > 0 ? parseFloat((totalFact / totalSpend).toFixed(2)) : 0;

    return res.json({
      ok: true,
      total_spend: totalSpend,
      total_facturacion: totalFact,
      roas: roasTotal,
      clicks: totalClicks,
      impressions: totalImpressions,
      items_procesados: allCampaigns.length,
      por_campana: Object.values(porCampana),
      periodo: { desde: dateFrom, hasta: dateTo },
    });

  } catch (err) {
    console.error('Error en ads.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
