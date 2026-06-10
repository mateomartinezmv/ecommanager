// api/meli/ads.js
// GET /api/meli/ads?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Llama a /advertising/advertisers/{id}/product_ads/items con metrics_summary=true
// Los campos correctos son: metrics.cost, metrics.clicks, metrics.prints

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const METRICS_FIELDS = 'clicks,prints,cost,cpc,acos,cvr,roas,ctr';

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

    // 1. Obtener usuario
    const meRes = await fetch('https://api.mercadolibre.com/users/me', { headers });
    const me = await meRes.json();
    if (!me.id) return res.json({ ok: false, error: 'No se pudo obtener el usuario MELI' });

    // 2. Resolver advertiser_id y site_id
    const advRes = await fetch(
      `https://api.mercadolibre.com/advertising/advertisers?user_id=${me.id}&product_id=PADS`,
      { headers }
    );
    const advData = await advRes.json();
    if (!advRes.ok || !advData.advertisers?.length) {
      return res.json({ ok: false, sin_acceso: true, mensaje: 'No se encontró perfil de anunciante en MELI Ads.' });
    }
    const { advertiser_id: advertiserId } = advData.advertisers[0];

    // 3. Obtener items con métricas del período — paginado hasta agotar resultados
    const base = `https://api.mercadolibre.com/advertising/advertisers/${advertiserId}/product_ads/items`;
    const allItems = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const url = `${base}?date_from=${dateFrom}&date_to=${dateTo}&metrics_summary=true&metrics=${METRICS_FIELDS}&limit=${limit}&offset=${offset}`;
      const r = await fetch(url, { headers });
      const body = await r.json();

      if (!r.ok) {
        return res.json({
          ok: false,
          error: `Error ${r.status} al obtener items de MELI Ads`,
          detalle: body
        });
      }

      const rows = body.results || body.data || body.items || [];
      allItems.push(...rows);

      const total = body.paging?.total ?? rows.length;
      if (allItems.length >= total || rows.length < limit) break;
      offset += limit;
    }

    if (allItems.length === 0) {
      return res.json({ ok: true, total_spend: 0, clicks: 0, impressions: 0, por_campana: [], items_procesados: 0, periodo: { desde: dateFrom, hasta: dateTo } });
    }

    // 4. Agregar por campaña y guardar en Supabase
    const porCampana = {};
    for (const item of allItems) {
      const cid = String(item.campaign_id || 'unknown');
      const m = item.metrics || {};
      const spend = parseFloat(m.cost || 0);
      const clicks = parseInt(m.clicks || 0, 10);
      const impressions = parseInt(m.prints || 0, 10);

      if (!porCampana[cid]) {
        porCampana[cid] = { campaign_id: cid, campaign_name: cid, spend: 0, clicks: 0, impressions: 0 };
      }
      porCampana[cid].spend += spend;
      porCampana[cid].clicks += clicks;
      porCampana[cid].impressions += impressions;
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
          currency,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'fecha,campaign_id' }
      );
    }

    const totalSpend = Object.values(porCampana).reduce((s, c) => s + c.spend, 0);
    const totalClicks = Object.values(porCampana).reduce((s, c) => s + c.clicks, 0);
    const totalImpressions = Object.values(porCampana).reduce((s, c) => s + c.impressions, 0);

    return res.json({
      ok: true,
      total_spend: totalSpend,
      clicks: totalClicks,
      impressions: totalImpressions,
      items_procesados: allItems.length,
      por_campana: Object.values(porCampana),
      periodo: { desde: dateFrom, hasta: dateTo },
    });

  } catch (err) {
    console.error('Error en ads.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
