// api/meli/ads-anuncios.js
// GET /api/meli/ads-anuncios?campaign_id=358477958&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// GET /api/meli/ads-anuncios?campaign_id=358477958&dias=30
// GET /api/meli/ads-anuncios?campaign_id=...&guardar=1   (sólo si desde == hasta)
//
// Abre una campaña de Product Ads producto por producto, igual que el panel de MELI, y le
// suma lo que MELI no sabe: el costo del CRM, el margen de contribución y el ROAS de
// equilibrio de cada anuncio.
//
// Sobre la estructura de MELI: desde el flujo de variantes unificadas, la fila del panel
// NO es un item_id sino un **ad group**. Un ad group de tipo FAMILY agrupa todas las
// variantes de un producto (el "5 variantes" que se ve en pantalla); uno de tipo ITEM es
// una publicación suelta. Los endpoints de métricas por anuncio quedaron deprecados y
// fueron dados de baja el 30/05/2026, así que la lectura va por ad group.
//
// Vinculación con el CRM: se resuelve por los item_ids del ad group contra
// productos.meli_ids. Si ninguno matchea, se entra a la publicación en MELI y se lee el
// SKU del vendedor (seller_custom_field o el atributo SELLER_SKU) para intentar el match
// por SKU. Cuando el SKU existe en el CRM pero el MLU no estaba en meli_ids, la respuesta
// lo marca como `sku_sin_vincular`: es un arreglo de un click en Stock, no un producto
// faltante.

const { getSupabase } = require('../_supabase');
const { getAdsContext, adsGet, resolverRango, enLotes, API } = require('./_adsClient');

// Este endpoint toma las métricas en MAYÚSCULAS (los de campaña, en minúsculas).
const METRICS_AD_GROUP = [
  'CLICKS', 'PRINTS', 'COST', 'CPC', 'CTR', 'TOTAL_AMOUNT', 'DIRECT_AMOUNT',
  'INDIRECT_AMOUNT', 'UNITS_QUANTITY', 'DIRECT_UNITS_QUANTITY', 'INDIRECT_UNITS_QUANTITY',
  'ORGANIC_UNITS_QUANTITY', 'ORGANIC_UNITS_AMOUNT', 'ACOS', 'TACOS', 'SOV', 'CVR', 'ROAS',
].join(',');

const METRICS_ADS = 'clicks,prints,cost,cpc,ctr,total_amount,units_quantity,roas,cvr';

// Comisión de MELI por defecto. Es la misma que usa procesar-orden-meli para valorizar
// las ventas; se puede pisar por request con ?comision=12.5 para simular otra categoría.
const COMISION_DEFAULT = 15;

const CONCURRENCIA = 6;
const PAGINA = 200;
// Tope de seguridad: cada ad group dispara una llamada extra para traer sus publicaciones,
// así que una campaña enorme no puede entrar entera en el tiempo de un lambda.
const MAX_AD_GROUPS = 600;

// Métricas de la campaña (este endpoint las toma en minúsculas).
const METRICS_CAMPANA = 'clicks,prints,cost,cpc,ctr,units_quantity,total_amount,acos,roas';

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const ent = v => (v === null || v === undefined ? 0 : parseInt(v, 10) || 0);
const r2 = v => Math.round(v * 100) / 100;

/** SKU que el vendedor cargó en la publicación, mirando los dos lugares donde MELI lo guarda. */
function skuDePublicacion(item) {
  if (item?.seller_custom_field) return String(item.seller_custom_field).trim();
  const attr = (item?.attributes || []).find(a => a.id === 'SELLER_SKU');
  if (attr?.value_name) return String(attr.value_name).trim();
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const campaignId = req.query.campaign_id;
  if (!campaignId) return res.status(400).json({ ok: false, error: 'Falta campaign_id' });

  const comisionPct = num(req.query.comision) || COMISION_DEFAULT;
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

    // ── 1. Los ad groups de la campaña, con sus métricas del período ──────────────
    // filters[campaign_id] (singular) trae todos los ítems que ESTUVIERON en la campaña
    // durante el rango. filters[campaigns] devuelve sólo los que siguen en ella hoy, y
    // entonces el gasto de un anuncio que se sacó a mitad de semana desaparece de la suma
    // aunque MELI lo siga contando en el total de la campaña.
    const urlGrupos = (offset) =>
      `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/ad_groups/search`
      + `?date_from=${rango.desde}&date_to=${rango.hasta}`
      + `&metrics=${METRICS_AD_GROUP}&metrics_summary=true`
      + `&limit=${PAGINA}&offset=${offset}&sort=desc&sort_by=cost`
      + `&${encodeURIComponent('filters[campaign_id]')}=${encodeURIComponent(campaignId)}`;

    const crudos = [];
    let offset = 0;
    let total = null;
    let truncado = false;

    // Paginar hasta agotar: una campaña con muchos anuncios no entra en una página, y lo
    // que no se pida queda fuera de los totales sin que se note.
    while (offset === 0 || offset < total) {
      const pagina = await adsGet(urlGrupos(offset), ctx.headers);
      if (!pagina.ok) {
        return res.json({
          ok: false,
          error: `Error ${pagina.status} al pedir los anuncios de la campaña`,
          periodo: { desde: rango.desde, hasta: rango.hasta },
          detalle: pagina.body,
        });
      }
      const lote = pagina.body.results || [];
      crudos.push(...lote);
      total = pagina.body.paging?.total ?? crudos.length;
      offset += PAGINA;
      if (!lote.length) break;
      if (crudos.length >= MAX_AD_GROUPS) { truncado = true; break; }
    }

    // ── 1b. El total que MELI le pone a la campaña ────────────────────────────────
    // Es la cifra que el vendedor ve en el panel de Ads y la que factura, así que manda
    // sobre la suma de los anuncios. Si las dos no coinciden, el hueco se muestra en vez
    // de taparse: casi siempre es gasto de anuncios que ya no están en la campaña.
    // Es una comodidad, no la tabla: si falla, la pestaña igual tiene que cargar.
    let campanaRes = { ok: false, body: {} };
    try {
      campanaRes = await adsGet(
        `${API}/advertising/${ctx.siteId}/product_ads/campaigns/${encodeURIComponent(campaignId)}`
        + `?date_from=${rango.desde}&date_to=${rango.hasta}&metrics=${METRICS_CAMPANA}`,
        ctx.headers
      );
    } catch (e) {
      console.error('ads-anuncios: no se pudo leer el total de la campaña:', e.message);
    }
    const mc = campanaRes.ok ? (campanaRes.body.metrics || campanaRes.body) : null;
    const campana = mc ? {
      nombre: campanaRes.body.name || null,
      impresiones: ent(mc.prints),
      clics: ent(mc.clicks),
      inversion: r2(num(mc.cost)),
      facturacion: r2(num(mc.total_amount)),
      unidades: ent(mc.units_quantity),
      roas: num(mc.cost) > 0 ? r2(num(mc.total_amount) / num(mc.cost)) : 0,
    } : null;

    // ── 2. Las publicaciones detrás de cada ad group ──────────────────────────────
    // El search de ad groups no devuelve los item_ids, y sin ellos no hay forma de
    // vincular con el CRM ni de abrir la publicación desde la tabla.
    const detalles = await enLotes(crudos, CONCURRENCIA, async g => {
      const url = `${API}/advertising/${ctx.siteId}/product_ads/ad_groups/${g.id}/ads`
        + `?date_from=${rango.desde}&date_to=${rango.hasta}&metrics=${METRICS_ADS}`;
      const r = await adsGet(url, ctx.headers);
      return r.ok ? (r.body.results || []) : [];
    });

    // ── 3. Catálogo del CRM para resolver SKU y costo ─────────────────────────────
    const supabase = getSupabase();
    const { data: productos, error: errProd } = await supabase
      .from('productos')
      .select('sku, nombre, costo, precio, meli_id, meli_ids');
    if (errProd) throw errProd;

    const porMeliId = new Map();
    const porSku = new Map();
    for (const p of productos || []) {
      porSku.set(String(p.sku).trim().toUpperCase(), p);
      for (const id of [p.meli_id, ...(p.meli_ids || [])]) {
        if (id) porMeliId.set(String(id).trim().toUpperCase(), p);
      }
    }

    // ── 4. Armado de filas ────────────────────────────────────────────────────────
    const filas = crudos.map((g, i) => {
      const ads = detalles[i] || [];
      const itemIds = ads.map(a => a.item_id).filter(Boolean);
      const m = g.metrics || {};

      const producto = itemIds.map(id => porMeliId.get(String(id).toUpperCase())).find(Boolean) || null;

      const impresiones = ent(m.prints);
      const clics       = ent(m.clicks);
      const inversion   = num(m.cost);
      const facturacion = num(m.total_amount);
      const unidades    = ent(m.units_quantity);

      // MELI ya manda roas/ctr/cpc calculados, pero vienen en 0 cuando no hubo actividad
      // y redondeados; se recalculan desde los crudos para que la tabla cierre sola.
      const roas = inversion > 0 ? facturacion / inversion : 0;
      const ctr  = impresiones > 0 ? (clics / impresiones) * 100 : 0;
      const cpc  = clics > 0 ? inversion / clics : 0;
      const cvr  = clics > 0 ? (unidades / clics) * 100 : 0;
      // ACOS = qué porcentaje de lo facturado se fue en publicidad. Es el inverso del
      // ROAS y el número con el que MELI configura las campañas por objetivo.
      const acos = facturacion > 0 ? (inversion / facturacion) * 100 : 0;

      // Precio realmente cobrado: la facturación atribuida sobre las unidades vendidas.
      // Cae por debajo del precio de lista cuando hubo descuento, que es lo que importa
      // para el margen. Sin ventas en el período, se usa el precio de la publicación.
      const precioPublicado = num(ads[0]?.price) || num(producto?.precio);
      const precioReal = unidades > 0 && facturacion > 0 ? facturacion / unidades : precioPublicado;

      const fila = {
        ad_group_id: String(g.id),
        campaign_id: String(g.campaign_id ?? campaignId),
        tipo: g.ad_group_type || null,          // FAMILY = agrupa variantes, ITEM = suelta
        titulo: g.title || ads[0]?.title || `Ad group ${g.id}`,
        thumbnail: g.thumbnail || ads[0]?.thumbnail || null,
        status: g.status || null,
        item_ids: itemIds,
        variantes: itemIds.length,
        permalink: ads[0]?.permalink || null,
        impresiones, clics, inversion, facturacion, unidades,
        ctr: r2(ctr), cpc: r2(cpc), cvr: r2(cvr), roas: r2(roas), acos: r2(acos),
        tacos: r2(num(m.tacos)),
        sov: r2(num(m.sov)),
        unidades_organicas: ent(m.organic_units_quantity),
        facturacion_organica: num(m.organic_units_amount),
        precio_publicado: r2(precioPublicado),
        precio_real: r2(precioReal),
        // Economía: se completa abajo si hay costo en el CRM.
        sku: producto?.sku || null,
        costo: producto ? num(producto.costo) : null,
        comision_pct: comisionPct,
        sin_vincular: !producto,
        sku_publicacion: null,
        sku_sin_vincular: false,
      };

      if (producto && precioReal > 0) {
        const comision = precioReal * (comisionPct / 100);
        const contribucion = precioReal - num(producto.costo) - comision;
        const margen = contribucion / precioReal;

        fila.comision = r2(comision);
        fila.contribucion = r2(contribucion);
        fila.margen = r2(margen * 100);
        // El corazón de la tabla: por debajo de este ROAS el anuncio destruye plata.
        fila.roas_breakeven = margen > 0 ? r2(1 / margen) : null;
        fila.cpa_max = r2(contribucion);
        // El CPC máximo sale de la conversión del período. Sin ventas no hay conversión
        // medida, y un "$0" se leería como "no pujes", que no es lo que dice el dato.
        fila.cpc_max = unidades > 0 ? r2(contribucion * (cvr / 100)) : null;
        fila.ganancia = r2(contribucion * unidades - inversion);
        fila.estado = fila.roas_breakeven == null ? 'sin_margen'
          : roas === 0 && inversion === 0 ? 'sin_datos'
          : roas >= fila.roas_breakeven * 1.15 ? 'ganando'
          : roas >= fila.roas_breakeven ? 'al_filo'
          : 'perdiendo';
      } else {
        fila.estado = 'sin_costo';
      }

      return fila;
    });

    // ── 5. Los que no vincularon: entrar a la publicación y leer su SKU ───────────
    // Es el paso que convierte un "#MLU2081747773 desconocido" en "este anuncio es el SKU
    // X, que ya está en el CRM pero sin este MLU cargado".
    const huerfanos = filas.filter(f => f.sin_vincular && f.item_ids.length);
    if (huerfanos.length) {
      await enLotes(huerfanos, CONCURRENCIA, async f => {
        for (const itemId of f.item_ids) {
          const r = await adsGet(
            `${API}/items/${itemId}?attributes=id,title,permalink,seller_custom_field,attributes`,
            ctx.headers, '1'
          );
          if (!r.ok) continue;
          if (!f.permalink && r.body.permalink) f.permalink = r.body.permalink;
          const sku = skuDePublicacion(r.body);
          if (!sku) continue;

          f.sku_publicacion = sku;
          const p = porSku.get(sku.toUpperCase());
          if (p) {
            // El producto existe en el CRM: falta el MLU en productos.meli_ids.
            f.sku = p.sku;
            f.costo = num(p.costo);
            f.sku_sin_vincular = true;
            f.item_id_faltante = itemId;
          }
          return;
        }
      });

      // Recalcular la economía de los que aparecieron por SKU.
      for (const f of huerfanos) {
        if (!f.sku_sin_vincular || !f.precio_real) continue;
        const comision = f.precio_real * (comisionPct / 100);
        const contribucion = f.precio_real - f.costo - comision;
        const margen = contribucion / f.precio_real;
        f.comision = r2(comision);
        f.contribucion = r2(contribucion);
        f.margen = r2(margen * 100);
        f.roas_breakeven = margen > 0 ? r2(1 / margen) : null;
        f.cpa_max = r2(contribucion);
        f.cpc_max = f.unidades > 0 ? r2(contribucion * (f.cvr / 100)) : null;
        f.ganancia = r2(contribucion * f.unidades - f.inversion);
        f.estado = f.roas_breakeven == null ? 'sin_margen'
          : f.roas >= f.roas_breakeven * 1.15 ? 'ganando'
          : f.roas >= f.roas_breakeven ? 'al_filo'
          : 'perdiendo';
      }
    }

    // ── 6. Totales ────────────────────────────────────────────────────────────────
    const sum = (campo) => filas.reduce((a, f) => a + (f[campo] || 0), 0);
    const inversionTotal = sum('inversion');
    const facturacionTotal = sum('facturacion');
    // Sólo suma la ganancia de los anuncios con costo cargado; mezclar los otros daría un
    // número optimista que parece real.
    const conCosto = filas.filter(f => f.ganancia !== undefined);

    const totales = {
      anuncios: filas.length,
      impresiones: sum('impresiones'),
      clics: sum('clics'),
      inversion: r2(inversionTotal),
      facturacion: r2(facturacionTotal),
      unidades: sum('unidades'),
      roas: inversionTotal > 0 ? r2(facturacionTotal / inversionTotal) : 0,
      ganancia: r2(conCosto.reduce((a, f) => a + f.ganancia, 0)),
      anuncios_con_costo: conCosto.length,
      anuncios_sin_vincular: filas.filter(f => f.sin_vincular && !f.sku_sin_vincular).length,
      anuncios_sku_sin_vincular: filas.filter(f => f.sku_sin_vincular).length,
      truncado: truncado ? { mostrados: filas.length, total } : null,
    };

    // Lo que la campaña gastó y no aparece en ningún anuncio de la lista. Se informa
    // siempre que sea más del 1%: es plata real y el ROAS de la campaña depende de ella.
    if (campana) {
      const dif = {
        inversion: r2(campana.inversion - totales.inversion),
        clics: campana.clics - totales.clics,
        facturacion: r2(campana.facturacion - totales.facturacion),
        unidades: campana.unidades - totales.unidades,
      };
      const relevante = campana.inversion > 0 &&
        Math.abs(dif.inversion) / campana.inversion > 0.01;
      totales.campana = campana;
      totales.diferencia = relevante ? dif : null;
    }

    // ── 7. Snapshot opcional ──────────────────────────────────────────────────────
    // Sólo tiene sentido para un día puntual: con un rango, las métricas vienen agregadas
    // y no se pueden atribuir a una fecha.
    let guardados = 0;
    if (req.query.guardar === '1' && rango.desde === rango.hasta && filas.length) {
      const fetchedAt = new Date().toISOString();
      const { error } = await supabase.from('meli_ads_anuncios').upsert(
        filas.map(f => ({
          fecha: rango.desde,
          ad_group_id: f.ad_group_id,
          campaign_id: f.campaign_id,
          campaign_name: req.query.campaign_name || null,
          titulo: f.titulo,
          thumbnail: f.thumbnail,
          status: f.status,
          ad_group_type: f.tipo,
          item_ids: f.item_ids,
          sku: f.sku,
          impressions: f.impresiones,
          clicks: f.clics,
          spend: f.inversion,
          facturacion: f.facturacion,
          unidades: f.unidades,
          currency: ctx.currency,
          fetched_at: fetchedAt,
        })),
        { onConflict: 'fecha,ad_group_id' }
      );
      if (error) throw error;
      guardados = filas.length;
    }

    return res.json({
      ok: true,
      periodo: { desde: rango.desde, hasta: rango.hasta },
      recortado: rango.recortado,
      campaign_id: String(campaignId),
      currency: ctx.currency,
      comision_pct: comisionPct,
      guardados,
      totales,
      anuncios: filas,
    });

  } catch (err) {
    console.error('Error en ads-anuncios.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
