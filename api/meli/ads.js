// api/meli/ads.js
// GET /api/meli/ads?desde=YYYY-MM-DD&hasta=YYYY-MM-DD

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
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 1. Obtener usuario
    const meRes = await fetch('https://api.mercadolibre.com/users/me', { headers });
    const me = await meRes.json();
    if (!me.id) return res.json({ ok: false, error: 'No se pudo obtener el usuario MELI' });
    const userId = me.id;

    // 2. Resolver advertiser_id y site_id
    const advertiserRes = await fetch(
      `https://api.mercadolibre.com/advertising/advertisers?user_id=${userId}&product_id=PADS`,
      { headers }
    );
    const advertiserData = await advertiserRes.json();
    if (!advertiserRes.ok || !advertiserData.advertisers?.length) {
      return res.json({ ok: false, sin_acceso: true, mensaje: 'No se encontró perfil de anunciante en MELI Ads.' });
    }
    const { advertiser_id: advertiserId, site_id: siteId } = advertiserData.advertisers[0];

    // 3. Obtener listado de campañas (para tener sus IDs)
    const campaignsRes = await fetch(
      `https://api.mercadolibre.com/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search`,
      { headers }
    );
    const campaignsData = await campaignsRes.json();
    const campaigns = campaignsData.results || campaignsData.data || campaignsData.campaigns || [];
    const campaignIds = campaigns.map(c => String(c.id || c.campaign_id)).filter(Boolean).join(',');

    // 4. Probar el endpoint correcto de items/métricas
    // Base correcta: /advertising/advertisers/{id}/product_ads/items (sin marketplace prefix)
    // También intentamos con el prefix marketplace por si acaso
    const baseCorrect = `https://api.mercadolibre.com/advertising/advertisers/${advertiserId}/product_ads/items`;
    const baseMarket = `https://api.mercadolibre.com/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/items`;

    const probes = [
      // Endpoint correcto según documentación, parámetros simples
      { key: 'correct_simple', url: `${baseCorrect}?date_from=${dateFrom}&date_to=${dateTo}&limit=50` },
      // Endpoint correcto con filtros entre corchetes (sintaxis oficial MELI filters)
      { key: 'correct_filters', url: `${baseCorrect}?filters[date_from]=${dateFrom}&filters[date_to]=${dateTo}&limit=50` },
      // Con campaign_ids en filtros
      { key: 'correct_filters_campaigns', url: `${baseCorrect}?filters[date_from]=${dateFrom}&filters[date_to]=${dateTo}&filters[campaign_ids]=${campaignIds}&limit=50` },
      // Con aggregation_type=daily
      { key: 'correct_daily', url: `${baseCorrect}?date_from=${dateFrom}&date_to=${dateTo}&aggregation_type=daily&limit=50` },
      // Sin parámetros de fecha (ver qué devuelve)
      { key: 'correct_no_dates', url: `${baseCorrect}?limit=10` },
      // Marketplace prefix con filtros en corchetes
      { key: 'market_filters', url: `${baseMarket}?filters[date_from]=${dateFrom}&filters[date_to]=${dateTo}&limit=50` },
    ];

    const results = {};
    for (const p of probes) {
      const r = await fetch(p.url, { headers });
      let body;
      try { body = await r.json(); } catch { body = {}; }
      results[p.key] = {
        status: r.status,
        // Para 200 devolver primeros 800 chars; para errores devolver el body completo (suele ser corto)
        body: r.status === 200 ? JSON.stringify(body).slice(0, 800) : JSON.stringify(body).slice(0, 400),
      };
      // Si encontramos respuesta exitosa con datos, procesar y salir
      if (r.status === 200) {
        const rows = body.results || body.data || body.items || [];
        if (Array.isArray(rows) && rows.length > 0) {
          // Procesar métricas y guardar en Supabase
          return await processItemsAndSave(rows, dateFrom, dateTo, siteId, advertiserId, supabase, me, res, p.key);
        }
      }
    }

    // Ningún probe funcionó — devolver diagnóstico completo
    return res.json({
      ok: false,
      error: 'No se pudo obtener métricas de items. Ver detalle de probes.',
      detalle: {
        user_id: userId,
        advertiser_id: advertiserId,
        site_id: siteId,
        campaign_ids: campaignIds,
        date_from: dateFrom,
        date_to: dateTo,
        probes: results,
      }
    });

  } catch (err) {
    console.error('Error en ads.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function processItemsAndSave(rows, dateFrom, dateTo, siteId, advertiserId, supabase, me, res, probeKey) {
  // Los items pueden tener métricas inline o anidadas bajo .metrics
  let totalSpend = 0;
  let totalClicks = 0;
  let totalImpressions = 0;

  // Agrupar por campaña
  const porCampana = {};
  for (const item of rows) {
    const cid = String(item.campaign_id || item.id || 'unknown');
    const m = item.metrics || item;
    const spend = parseFloat(m.cost || m.spend || m.investment || 0);
    const clicks = parseInt(m.clicks || 0, 10);
    const impressions = parseInt(m.prints || m.impressions || 0, 10);

    if (!porCampana[cid]) {
      porCampana[cid] = { campaign_id: cid, campaign_name: item.campaign_name || cid, spend: 0, clicks: 0, impressions: 0 };
    }
    porCampana[cid].spend += spend;
    porCampana[cid].clicks += clicks;
    porCampana[cid].impressions += impressions;
    totalSpend += spend;
    totalClicks += clicks;
    totalImpressions += impressions;
  }

  // Upsert en Supabase
  for (const c of Object.values(porCampana)) {
    await supabase.from('meli_ads_gastos').upsert(
      {
        fecha: dateTo,
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        spend: c.spend,
        clicks: c.clicks,
        impressions: c.impressions,
        currency: me.currency_id || 'UYU',
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'fecha,campaign_id' }
    );
  }

  return res.json({
    ok: true,
    total_spend: totalSpend,
    clicks: totalClicks,
    impressions: totalImpressions,
    items_procesados: rows.length,
    por_campana: Object.values(porCampana),
    periodo: { desde: dateFrom, hasta: dateTo },
    probe_exitoso: probeKey,
  });
}
