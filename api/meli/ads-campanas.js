// api/meli/ads-campanas.js
// GET /api/meli/ads-campanas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// GET /api/meli/ads-campanas?dias=N
//
// Lista las campañas de Product Ads con sus métricas en el rango pedido. Es el selector
// que alimenta la pestaña de Ads: elegida una campaña, /api/meli/ads-anuncios la abre
// producto por producto.

const { getAdsContext, adsGet, resolverRango, API } = require('./_adsClient');

const METRICS = [
  'clicks', 'prints', 'ctr', 'cost', 'cpc', 'acos', 'cvr', 'roas',
  'units_quantity', 'direct_amount', 'indirect_amount', 'total_amount',
].join(',');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rango = resolverRango(req.query);
  if (rango.vacio) {
    return res.json({ ok: false, error: `Rango vacío: ${rango.desde} es posterior a ${rango.hasta}.` });
  }

  try {
    let ctx;
    try {
      ctx = await getAdsContext();
    } catch (e) {
      if (e.sinAcceso) return res.json({ ok: false, sin_acceso: true, mensaje: e.message });
      return res.json({ ok: false, error: e.message || 'MELI no conectado' });
    }

    const url = `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/campaigns/search`
      + `?date_from=${rango.desde}&date_to=${rango.hasta}&metrics=${METRICS}&limit=200&offset=0`;

    const { ok, status, body } = await adsGet(url, ctx.headers);
    if (!ok) {
      return res.json({
        ok: false,
        error: `Error ${status} al pedir campañas a MELI`,
        periodo: { desde: rango.desde, hasta: rango.hasta },
        detalle: body,
      });
    }

    const campanas = (body.results || []).map(c => {
      const m = c.metrics || {};
      return {
        id: String(c.id),
        nombre: c.name || `Campaña ${c.id}`,
        status: c.status,
        presupuesto: c.budget ?? null,
        estrategia: c.strategy ?? null,
        acos_objetivo: c.acos_target ?? null,
        impresiones: parseInt(m.prints || 0, 10),
        clics: parseInt(m.clicks || 0, 10),
        ctr: parseFloat(m.ctr || 0),
        cpc: parseFloat(m.cpc || 0),
        inversion: parseFloat(m.cost || 0),
        facturacion: parseFloat(m.total_amount || 0),
        unidades: parseInt(m.units_quantity || 0, 10),
        roas: parseFloat(m.roas || 0),
        acos: parseFloat(m.acos || 0),
        cvr: parseFloat(m.cvr || 0),
      };
    });

    return res.json({
      ok: true,
      periodo: { desde: rango.desde, hasta: rango.hasta },
      recortado: rango.recortado,
      currency: ctx.currency,
      campanas,
    });

  } catch (err) {
    console.error('Error en ads-campanas.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
