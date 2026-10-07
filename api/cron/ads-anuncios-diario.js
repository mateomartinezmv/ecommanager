// api/cron/ads-anuncios-diario.js
// Cron — 14:20 UTC (11:20 Uruguay), veinte minutos después de ads-diario, que captura el
// gasto total del día. Este abre ese gasto por producto.
//
// Por qué hace falta: MELI sólo sirve 90 días de métricas y después no hay forma de
// recuperarlas. meli_ads_diario guarda el total de la cuenta, pero nada guardaba el detalle
// por anuncio, así que a los 90 días se perdía la respuesta a la pregunta que importa
// cuando se piensa volver a anunciar un producto: cómo le fue la última vez que se anunció.
// La sección de oportunidades de la pestaña de Ads lee este histórico.
//
// Vuelve a pedir los últimos días en lugar de sólo ayer: MELI sigue ajustando las métricas
// recientes y la clave (fecha, ad_group_id) hace que re-pedirlas corrija los valores en vez
// de duplicarlos.

const { getSupabase } = require('../_supabase');
const { getAdsContext, adsGet, enLotes, API, aFecha, sumarDias } = require('../meli/_adsClient');

const DIAS_A_REFRESCAR = 4;
const METRICS = 'CLICKS,PRINTS,COST,TOTAL_AMOUNT,UNITS_QUANTITY';
const PAGINA = 200;
const CONCURRENCIA = 8;
const MAX_AD_GROUPS = 600;

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const ent = v => (v === null || v === undefined ? 0 : parseInt(v, 10) || 0);
const up = v => String(v || '').trim().toUpperCase();

/** Ad groups de una campaña en un día, con sus métricas de ese día. */
async function gruposDelDia(ctx, campaignId, fecha) {
  const url = (offset) =>
    `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/ad_groups/search`
    + `?date_from=${fecha}&date_to=${fecha}&metrics=${METRICS}&metrics_summary=true`
    + `&limit=${PAGINA}&offset=${offset}&sort=desc&sort_by=cost`
    // Singular: incluye los anuncios que estuvieron en la campaña ese día y ya no están.
    + `&${encodeURIComponent('filters[campaign_id]')}=${encodeURIComponent(campaignId)}`;

  const grupos = [];
  let offset = 0;
  let total = null;
  while (offset === 0 || offset < total) {
    const pagina = await adsGet(url(offset), ctx.headers);
    if (!pagina.ok) break;
    const lote = pagina.body.results || [];
    grupos.push(...lote);
    total = pagina.body.paging?.total ?? grupos.length;
    offset += PAGINA;
    if (!lote.length || grupos.length >= MAX_AD_GROUPS) break;
  }
  return grupos;
}

module.exports = async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dias = Math.max(1, parseInt(req.query?.dias || DIAS_A_REFRESCAR, 10));

  try {
    let ctx;
    try {
      ctx = await getAdsContext();
    } catch (e) {
      // Sin perfil de anunciante no hay nada que capturar, y no es un error del cron.
      console.log('ads-anuncios-diario: sin acceso a Ads:', e.message);
      return res.status(200).json({ ok: false, sin_acceso: !!e.sinAcceso, mensaje: e.message });
    }

    const hoy = new Date();
    const fechas = Array.from({ length: dias }, (_, i) => aFecha(sumarDias(hoy, -(i + 1))));
    const desde = fechas[fechas.length - 1];
    const hasta = fechas[0];

    const camp = await adsGet(
      `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/campaigns/search`
      + `?date_from=${desde}&date_to=${hasta}&metrics=cost&limit=200&offset=0`,
      ctx.headers
    );
    if (!camp.ok) {
      console.error('ads-anuncios-diario: error al pedir campañas:', camp.status, camp.body);
      return res.status(200).json({ ok: false, error: `Error ${camp.status} al pedir campañas` });
    }
    const campanas = (camp.body.results || []).map(c => ({ id: String(c.id), nombre: c.name || `Campaña ${c.id}` }));

    // Un barrido por día y por campaña. Las métricas son del día; lo que no cambia de un
    // día al otro —las publicaciones que cuelgan de cada ad group— se pide una sola vez.
    const porDia = [];
    const nombreCampana = new Map();
    for (const c of campanas) {
      nombreCampana.set(c.id, c.nombre);
      for (const fecha of fechas) {
        for (const g of await gruposDelDia(ctx, c.id, fecha)) {
          porDia.push({ fecha, campaignId: String(g.campaign_id ?? c.id), grupo: g });
        }
      }
    }

    const idsGrupos = [...new Set(porDia.map(x => String(x.grupo.id)))];
    const itemIds = new Map();
    await enLotes(idsGrupos, CONCURRENCIA, async (id) => {
      const r = await adsGet(
        `${API}/advertising/${ctx.siteId}/product_ads/ad_groups/${encodeURIComponent(id)}/ads`,
        ctx.headers
      );
      itemIds.set(id, r.ok ? (r.body.results || []).map(a => a.item_id).filter(Boolean) : []);
    });

    // SKU del CRM, para que el histórico se pueda leer por producto y no sólo por ad group
    // (los ad groups cambian de id cuando se rearma la campaña).
    const supabase = getSupabase();
    const { data: productos, error: errProd } = await supabase
      .from('productos')
      .select('sku, meli_id, meli_ids');
    if (errProd) throw errProd;
    const porMeliId = new Map();
    for (const p of productos || []) {
      for (const id of [p.meli_id, ...(p.meli_ids || [])]) {
        if (id) porMeliId.set(up(id), p.sku);
      }
    }

    const fetchedAt = new Date().toISOString();
    const filas = porDia.map(({ fecha, campaignId, grupo: g }) => {
      const ids = itemIds.get(String(g.id)) || [];
      const m = g.metrics || {};
      return {
        fecha,
        ad_group_id: String(g.id),
        campaign_id: campaignId,
        campaign_name: nombreCampana.get(campaignId) || null,
        titulo: g.title || null,
        thumbnail: g.thumbnail || null,
        status: g.status || null,
        ad_group_type: g.ad_group_type || null,
        item_ids: ids,
        sku: ids.map(id => porMeliId.get(up(id))).find(Boolean) || null,
        impressions: ent(m.prints),
        clicks: ent(m.clicks),
        spend: num(m.cost),
        facturacion: num(m.total_amount),
        unidades: ent(m.units_quantity),
        currency: ctx.currency,
        fetched_at: fetchedAt,
      };
    });

    if (filas.length) {
      const { error } = await supabase
        .from('meli_ads_anuncios')
        .upsert(filas, { onConflict: 'fecha,ad_group_id' });
      if (error) throw error;
    }

    console.log(`ads-anuncios-diario: ${filas.length} filas (${fechas.length} días, ${campanas.length} campañas)`);
    return res.json({
      ok: true,
      periodo: { desde, hasta },
      campanas: campanas.length,
      ad_groups: idsGrupos.length,
      filas_guardadas: filas.length,
      sin_sku: filas.filter(f => !f.sku).length,
    });

  } catch (err) {
    console.error('Error en ads-anuncios-diario.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
