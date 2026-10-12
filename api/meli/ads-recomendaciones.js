// api/meli/ads-recomendaciones.js
// GET /api/meli/ads-recomendaciones?dias=30&historico_dias=90&limite=60
//
// La otra mitad de la pestaña de Ads. La tabla de anuncios dice cómo le va a lo que ya se
// está anunciando; esto mira el catálogo entero y dice qué hacer con cada producto: cuáles
// faltan anunciar, cuáles conviene apagar y cuáles escalar.
//
// MELI no puede contestar esto: su panel sólo conoce los productos que ya pusiste a
// competir. No sabe que tenés un producto con 63% de margen sin una sola impresión, ni que
// el que andaba bien en agosto lleva seis semanas apagado.
//
// ── Cómo decide que un producto "no se está anunciando" ───────────────────────────────
// Junta los ad groups de todas las campañas de Product Ads en el período y los resuelve a
// item_ids. Un producto cuyas publicaciones no aparecen en ningún ad group ACTIVO queda
// como candidato a anunciar. Las tres formas de estar afuera no se juzgan igual:
//   · nunca_anunciado   → no aparece en la ventana de MELI (90 días) ni en el histórico local.
//   · pausado           → el anuncio existe en la campaña pero está pausado: se reactiva y listo.
//   · salio_de_campana  → estuvo anunciándose en la ventana y ya no está.
//
// ── Antes de recomendar, mirar cómo le fue ────────────────────────────────────────────
// Volver a prender un anuncio que perdía plata es repetir el error con más convicción. El
// histórico sale de dos lados que se suman sin pisarse:
//   · MELI en vivo: las métricas del ad group en los 90 días que sirve la API.
//   · meli_ads_anuncios: el snapshot diario local, lo único que sobrevive a esos 90 días.
//     Sólo se suman los días ANTERIORES a la ventana de la API, así que un día capturado en
//     los dos lados no se cuenta dos veces. Lo llena api/cron/ads-anuncios-diario.js.
// Ese ROAS histórico se compara contra el ROAS de equilibrio de HOY (con el costo y el
// precio de hoy): un producto que perdía plata cuando se anunciaba vuelve a la lista
// marcado en rojo, no como oportunidad.
//
// ── La economía ───────────────────────────────────────────────────────────────────────
// El margen sale de _economia.js: la comisión que MELI cobró de verdad en las ventas del
// SKU y el envío que se despachó, no un 15% fijo sin envío. Es la misma cuenta que usa la
// tabla de anuncios, así que los dos números se pueden comparar de una sección a la otra.

const { getSupabase } = require('../_supabase');
const { getAdsContext, adsGet, resolverRango, enLotes, API } = require('./_adsClient');
const { meliIdsDe } = require('../_meliIds');
const { cargarEconomia, deSku, contribucionUnitaria } = require('./_economia');

// El search de ad groups toma las métricas en MAYÚSCULAS (el de campañas, en minúsculas).
const METRICS_AD_GROUP = ['CLICKS', 'PRINTS', 'COST', 'TOTAL_AMOUNT', 'UNITS_QUANTITY'].join(',');
const METRICS_CAMPANA = 'clicks,prints,cost,cpc,ctr,cvr,units_quantity,total_amount,roas';

const HISTORICO_DIAS = 90;       // todo lo que MELI sirve hacia atrás
const LIMITE_DEFAULT = 60;
const CONCURRENCIA = 8;
const PAGINA = 200;
const MAX_AD_GROUPS = 600;
const LOTE_ITEMS = 20;           // tope del multiget de /items
// Estados de publicación que pueden recibir tráfico de ads.
const ESTADO_ANUNCIABLE = 'active';

// ── Umbrales ────────────────────────────────────────────────────────────────────────
// El único lugar donde vive el criterio: tocar acá cambia todo el tablero.
const UMBRALES = {
  // Debajo de esta cantidad de clics la conversión propia del producto es ruido y se usa la
  // de la cuenta: con 3 clics y una venta daría 33% y el CPC máximo saldría absurdo.
  clics_min_cvr_propio: 20,
  // Para juzgar un anuncio que está corriendo hace falta que haya gastado algo real.
  clics_para_juzgar: 40,
  // Cuánto por encima del equilibrio tiene que estar para decir "escalalo".
  holgura_escalar: 1.35,
  // Meses de stock a partir de los cuales el inventario está dormido.
  meses_stock_dormido: 4,
  // Un ROAS de equilibrio por encima de esto es un producto que ads no puede sostener.
  roas_be_inviable: 4,
};

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const ent = v => (v === null || v === undefined ? 0 : parseInt(v, 10) || 0);
const r2 = v => Math.round(v * 100) / 100;
const up = v => String(v || '').trim().toUpperCase();

/**
 * Todos los ad groups de una campaña en el rango, paginando hasta agotar.
 *
 * `filters[campaign_id]` en singular a propósito: trae todo lo que ESTUVO en la campaña
 * durante el rango. Con el plural se perdería justo lo que acá interesa, los que salieron.
 *
 * Devuelve { grupos, truncado, error }: cortar en el tope sin avisar haría aparecer como
 * "sin anunciar" a productos que sí tienen anuncio, que es el peor error posible acá.
 */
async function traerGrupos(ctx, campaignId, desde, hasta) {
  const url = (offset) =>
    `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/ad_groups/search`
    + `?date_from=${desde}&date_to=${hasta}`
    + `&metrics=${METRICS_AD_GROUP}&metrics_summary=true`
    + `&limit=${PAGINA}&offset=${offset}&sort=desc&sort_by=cost`
    + `&${encodeURIComponent('filters[campaign_id]')}=${encodeURIComponent(campaignId)}`;

  const grupos = [];
  let offset = 0;
  let total = null;
  let truncado = false;
  let error = null;
  while (offset === 0 || offset < total) {
    const pagina = await adsGet(url(offset), ctx.headers);
    if (!pagina.ok) { error = `Error ${pagina.status} al pedir los anuncios de la campaña ${campaignId}`; break; }
    const lote = pagina.body.results || [];
    grupos.push(...lote);
    total = pagina.body.paging?.total ?? grupos.length;
    offset += PAGINA;
    if (!lote.length) break;
    if (grupos.length >= MAX_AD_GROUPS) { truncado = true; break; }
  }
  return { grupos, truncado, error };
}

/** item_ids de cada ad group. El search no los devuelve y sin ellos no hay cómo cruzar con el CRM. */
async function itemIdsDeGrupos(ctx, ids) {
  const mapa = new Map();
  await enLotes([...ids], CONCURRENCIA, async (id) => {
    // Sin métricas: acá sólo se necesita saber qué publicaciones cuelgan del ad group.
    const r = await adsGet(
      `${API}/advertising/${ctx.siteId}/product_ads/ad_groups/${encodeURIComponent(id)}/ads`,
      ctx.headers
    );
    mapa.set(String(id), r.ok ? (r.body.results || []).map(a => a.item_id).filter(Boolean) : []);
  });
  return mapa;
}

/**
 * Estado, precio y stock de cada publicación, por multiget de /items.
 *
 * El CRM puede tener stock y la publicación estar pausada o en cero en MELI. Anunciar eso
 * es tirar la plata, y recomendarlo es peor: manda a gastar en algo que no puede vender.
 */
async function traerPublicaciones(ctx, ids) {
  const unicos = [...new Set(ids.filter(Boolean).map(String))];
  const mapa = new Map();
  const lotes = [];
  for (let i = 0; i < unicos.length; i += LOTE_ITEMS) lotes.push(unicos.slice(i, i + LOTE_ITEMS));

  await enLotes(lotes, CONCURRENCIA, async (lote) => {
    const r = await adsGet(
      `${API}/items?ids=${lote.join(',')}`
      + `&attributes=id,title,status,sub_status,price,available_quantity,sold_quantity,permalink,thumbnail`,
      ctx.headers, '1'
    );
    if (!r.ok || !Array.isArray(r.body)) return;
    for (const entrada of r.body) {
      const it = entrada?.code === 200 ? entrada.body : null;
      if (!it?.id) continue;
      mapa.set(String(it.id), {
        meli_id: String(it.id),
        titulo: it.title || null,
        estado: it.status || null,
        sub_estado: (it.sub_status || [])[0] || null,
        precio: num(it.price),
        stock: Number.isFinite(it.available_quantity) ? it.available_quantity : null,
        vendidas: ent(it.sold_quantity),
        permalink: it.permalink || null,
        thumbnail: it.thumbnail || null,
      });
    }
  });
  return mapa;
}

/**
 * Suma de métricas de ad groups (las del search vienen en minúsculas dentro de `metrics`).
 *
 * `parte` es la fracción del anuncio que le toca al producto que se está mirando. Un ad
 * group de tipo FAMILY agrupa todas las variantes de una publicación —el "5 variantes" del
 * panel de MELI— y esas variantes pueden ser SKU distintos del CRM. MELI sirve las métricas
 * del grupo entero y no las abre por variante (los endpoints por anuncio quedaron
 * deprecados), así que sin repartir, cada SKU se llevaba el 100% del gasto: tres colores de
 * un mismo manillar mostraban $1.002 cada uno cuando el anuncio gastó $1.002 en total.
 */
function sumarGrupos(grupos, parte = () => 1) {
  const t = { impresiones: 0, clics: 0, inversion: 0, facturacion: 0, unidades: 0 };
  for (const g of grupos) {
    const m = g.metrics || {};
    const f = parte(g);
    t.impresiones += ent(m.prints) * f;
    t.clics += ent(m.clicks) * f;
    t.inversion += num(m.cost) * f;
    t.facturacion += num(m.total_amount) * f;
    t.unidades += ent(m.units_quantity) * f;
  }
  // Las unidades quedan fraccionadas al repartir: se redondean al cerrar para que la
  // tarjeta no diga "2.33 unidades", pero el reparto se hace sobre el crudo.
  t.unidades_exactas = t.unidades;
  t.unidades = Math.round(t.unidades);
  t.impresiones = Math.round(t.impresiones);
  t.clics = Math.round(t.clics);
  return t;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Pisar la comisión es para simular otra categoría; vacío quiere decir "usá la real".
  const comisionOverride = num(req.query.comision) || null;
  const envioParam = req.query.envio === undefined ? 'auto' : req.query.envio;
  const limite = Math.max(1, ent(req.query.limite) || LIMITE_DEFAULT);

  const rango = resolverRango(req.query);
  if (rango.vacio) {
    return res.json({ ok: false, error: `Rango vacío: ${rango.desde} es posterior a ${rango.hasta}.` });
  }
  const diasHist = Math.min(HISTORICO_DIAS, Math.max(ent(req.query.historico_dias) || HISTORICO_DIAS, 1));
  const rangoHist = resolverRango({ dias: diasHist });

  try {
    let ctx;
    try {
      ctx = await getAdsContext();
    } catch (e) {
      if (e.sinAcceso) return res.json({ ok: false, sin_acceso: true, mensaje: e.message });
      return res.json({ ok: false, error: e.message || 'MELI no conectado' });
    }

    // ── 1. Campañas y la referencia de la cuenta ──────────────────────────────────
    // El CPC y la conversión promedio de lo que YA se anuncia son la única vara para
    // estimar qué le costaría a un producto nuevo traer una venta por ads.
    const camp = await adsGet(
      `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/campaigns/search`
      + `?date_from=${rango.desde}&date_to=${rango.hasta}&metrics=${METRICS_CAMPANA}&limit=200&offset=0`,
      ctx.headers
    );
    if (!camp.ok) {
      return res.json({ ok: false, error: `Error ${camp.status} al pedir las campañas a MELI`, detalle: camp.body });
    }
    const campanas = (camp.body.results || []).map(c => ({
      id: String(c.id), nombre: c.name || `Campaña ${c.id}`, status: c.status, metrics: c.metrics || {},
    }));

    const refCuenta = campanas.reduce((a, c) => {
      a.clics += ent(c.metrics.clicks);
      a.inversion += num(c.metrics.cost);
      a.unidades += ent(c.metrics.units_quantity);
      a.facturacion += num(c.metrics.total_amount);
      return a;
    }, { clics: 0, inversion: 0, unidades: 0, facturacion: 0 });

    const cpcCuenta = refCuenta.clics > 0 ? refCuenta.inversion / refCuenta.clics : 0;
    const cvrCuenta = refCuenta.clics > 0 ? (refCuenta.unidades / refCuenta.clics) * 100 : 0;
    // Lo que cuesta hoy una venta traída por ads: la vara contra la que se mide la
    // contribución de cada producto. Si deja menos que esto, el clic no se paga.
    const cpaCuenta = cvrCuenta > 0 ? cpcCuenta / (cvrCuenta / 100) : null;

    // ── 2. Ad groups: lo que se anuncia ahora y lo que se anunció en la ventana ────
    const gruposRecientes = new Map();   // ad_group_id → grupo (métricas del período)
    const gruposHist = new Map();        // ad_group_id → grupo (métricas de los 90 días)
    const incompleto = [];               // campañas que no se pudieron leer enteras
    for (const c of campanas) {
      const reciente = await traerGrupos(ctx, c.id, rango.desde, rango.hasta);
      for (const g of reciente.grupos) {
        gruposRecientes.set(String(g.id), { ...g, campaign_id: String(g.campaign_id ?? c.id), campaign_name: c.nombre });
      }
      if (reciente.truncado || reciente.error) {
        incompleto.push({ campana: c.nombre, motivo: reciente.error || `tiene más de ${MAX_AD_GROUPS} anuncios` });
      }
      // Si el período pedido ya cubre los 90 días, el segundo barrido sería el mismo.
      if (rangoHist.desde < rango.desde) {
        const hist = await traerGrupos(ctx, c.id, rangoHist.desde, rangoHist.hasta);
        for (const g of hist.grupos) {
          gruposHist.set(String(g.id), { ...g, campaign_id: String(g.campaign_id ?? c.id), campaign_name: c.nombre });
        }
      }
    }
    for (const [id, g] of gruposRecientes) if (!gruposHist.has(id)) gruposHist.set(id, g);

    // Resolver las publicaciones de un ad group es una llamada a MELI por grupo, así que
    // la cuenta entera tiene que estar acotada y no sólo cada campaña por separado: con
    // varias campañas grandes, la suma no entra en el tiempo del lambda.
    const idsGrupos = [...gruposHist.keys()];
    const idsAResolver = idsGrupos.slice(0, MAX_AD_GROUPS);
    if (idsGrupos.length > idsAResolver.length) {
      incompleto.push({
        campana: 'todas',
        motivo: `hay ${idsGrupos.length} anuncios entre todas las campañas y se resolvieron ${idsAResolver.length}`,
      });
    }
    const itemIds = await itemIdsDeGrupos(ctx, idsAResolver);

    // Publicación → ad groups que la anuncian. Una publicación puede estar en más de un ad
    // group (una campaña por objetivo y otra manual, por ejemplo).
    const gruposDeItem = new Map();
    for (const [adGroupId, ids] of itemIds) {
      for (const id of ids) {
        const k = up(id);
        if (!gruposDeItem.has(k)) gruposDeItem.set(k, []);
        gruposDeItem.get(k).push(adGroupId);
      }
    }

    // ── 3. CRM: catálogo, ventas y la economía real de cada SKU ───────────────────
    const supabase = getSupabase();
    const [{ data: productos, error: errProd }, { data: ventas, error: errVentas }, economia] = await Promise.all([
      supabase.from('productos')
        .select('sku, nombre, grupo, costo, precio, stock_dep, stock_meli, meli_id, meli_ids, discontinuado')
        .limit(5000),
      supabase.from('ventas').select('sku, cantidad, canal, fecha, estado')
        .gte('fecha', rangoHist.desde).limit(50000),
      cargarEconomia(supabase, { envio: envioParam }),
    ]);
    if (errProd) throw errProd;
    if (errVentas) throw errVentas;

    // Cuántos SKU del CRM comparten cada anuncio. Es el divisor con el que se reparten
    // las métricas: un ad group de 5 variantes que son 3 productos distintos le aporta un
    // tercio a cada uno, no el total a los tres.
    const skuDeItem = new Map();
    for (const p of productos || []) {
      for (const id of meliIdsDe(p)) skuDeItem.set(up(id), up(p.sku));
    }
    const skusDeGrupo = new Map();
    for (const [adGroupId, ids] of itemIds) {
      skusDeGrupo.set(String(adGroupId), new Set(ids.map(id => skuDeItem.get(up(id))).filter(Boolean)));
    }
    // Un anuncio que no resuelve a ningún SKU no se reparte: no hay entre quiénes.
    const skusDelGrupo = (id) => skusDeGrupo.get(String(id))?.size || 1;
    const parteDelGrupo = (g) => 1 / skusDelGrupo(g.id ?? g);

    // Demanda propia: lo que el producto vende, con y sin que nadie lo empuje.
    const demanda = new Map();   // sku → { meli, total }
    for (const v of ventas || []) {
      const k = up(v.sku);
      if (!k || (v.estado || '') === 'cancelada') continue;
      if (!demanda.has(k)) demanda.set(k, { meli: 0, total: 0 });
      const d = demanda.get(k);
      const cant = Math.max(1, ent(v.cantidad));
      d.total += cant;
      if (/meli/i.test(v.canal || '')) d.meli += cant;
    }

    // ── 4. Partir el catálogo en los que se anuncian y los que no ─────────────────
    const descartados = {
      discontinuados: 0, sin_publicacion: 0, sin_costo: 0, sin_precio: 0,
      sin_publicacion_activa: 0,
    };

    const evaluables = [];
    for (const p of productos || []) {
      if (p.discontinuado) { descartados.discontinuados += 1; continue; }

      const ids = meliIdsDe(p);
      if (!ids.length) { descartados.sin_publicacion += 1; continue; }
      if (num(p.costo) <= 0) { descartados.sin_costo += 1; continue; }

      const propios = [...new Set(ids.flatMap(id => gruposDeItem.get(up(id)) || []))];
      const activos = propios.filter(id => up(gruposRecientes.get(id)?.status) === 'ACTIVE');

      evaluables.push({ producto: p, ids, grupos: propios, activos });
    }

    // El estado real de TODAS las publicaciones evaluables, anunciadas o no: un anuncio
    // corriendo sobre una publicación sin stock es plata quemándose ahora mismo.
    const pubs = await traerPublicaciones(ctx, evaluables.flatMap(c => c.ids));

    // ── 5. Histórico local, lo único que sobrevive a los 90 días ─────────────────
    const histLocal = new Map();
    let snapshotDisponible = true;
    if (evaluables.length) {
      // Sin filtro por `sku`: esa columna guarda UN solo SKU por fila, el primero que
      // matcheó al capturar, así que un anuncio de varias variantes quedaría entero
      // colgado de uno y los demás no verían nada. Las publicaciones del anuncio están
      // en `item_ids` y de ahí sale el reparto, igual que con la API en vivo.
      const { data: snaps, error: errSnap } = await supabase
        .from('meli_ads_anuncios')
        .select('fecha, sku, item_ids, campaign_name, impressions, clicks, spend, facturacion, unidades')
        .lt('fecha', rangoHist.desde)   // los días que la API ya contestó no se suman de nuevo
        .limit(50000);
      if (errSnap) {
        // Que la migración del snapshot no esté corrida no puede tumbar la sección: la API
        // ya cubre los 90 días y es la fuente principal. Sólo se pierde lo anterior.
        snapshotDisponible = false;
        console.error('ads-recomendaciones: no se pudo leer meli_ads_anuncios:', errSnap.message);
      }
      for (const s of snaps || []) {
        // Los SKU que comparten esa fila. Si los item_ids no resuelven (una publicación
        // que ya no está en el CRM), se cae a la columna `sku` que guardó el cron.
        const suyos = [...new Set((s.item_ids || []).map(id => skuDeItem.get(up(id))).filter(Boolean))];
        const destinos = suyos.length ? suyos : (s.sku ? [up(s.sku)] : []);
        if (!destinos.length) continue;
        const f = 1 / destinos.length;

        for (const k of destinos) {
          if (!histLocal.has(k)) {
            histLocal.set(k, {
              impresiones: 0, clics: 0, inversion: 0, facturacion: 0, unidades: 0,
              dias: new Set(), primer_dia: s.fecha, ultimo_dia: s.fecha, campanas: new Set(),
            });
          }
          const h = histLocal.get(k);
          h.impresiones += ent(s.impressions) * f;
          h.clics += ent(s.clicks) * f;
          h.inversion += num(s.spend) * f;
          h.facturacion += num(s.facturacion) * f;
          h.unidades += ent(s.unidades) * f;
          h.dias.add(s.fecha);
          if (s.fecha < h.primer_dia) h.primer_dia = s.fecha;
          if (s.fecha > h.ultimo_dia) h.ultimo_dia = s.fecha;
          if (s.campaign_name) h.campanas.add(s.campaign_name);
        }
      }
    }

    // ── 6. Una recomendación por producto ────────────────────────────────────────
    const diasVentana = Math.max(
      1, Math.round((new Date(rangoHist.hasta) - new Date(rangoHist.desde)) / 86400000) + 1
    );
    const diasPeriodo = Math.max(
      1, Math.round((new Date(rango.hasta) - new Date(rango.desde)) / 86400000) + 1
    );

    const filas = [];
    for (const c of evaluables) {
      const p = c.producto;
      const anunciado = c.activos.length > 0;

      // La publicación que recibe (o recibiría) el tráfico: la activa con más stock.
      const suyas = c.ids.map(id => pubs.get(String(id))).filter(Boolean);
      const anunciables = suyas.filter(x => x.estado === ESTADO_ANUNCIABLE);
      if (suyas.length && !anunciables.length && !anunciado) {
        descartados.sin_publicacion_activa += 1;
        continue;
      }
      const conStock = anunciables.filter(x => (x.stock ?? 0) > 0);
      const pub = conStock.sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0))[0]
        || anunciables[0] || suyas[0] || null;

      // Sin publicación leída (MELI no contestó) se cae al dato del CRM antes que descartar.
      const precio = num(pub?.precio) || num(p.precio);
      if (precio <= 0) { descartados.sin_precio += 1; continue; }
      const stockPub = pub?.stock ?? ent(p.stock_meli);
      const stockDep = ent(p.stock_dep);

      // ── La economía, con la comisión y el envío reales del SKU ──
      const costo = num(p.costo);
      const eco = deSku(economia, p.sku);
      const comisionPct = comisionOverride ?? eco.comision_pct;
      const econ = contribucionUnitaria({
        precio, costo, comision_pct: comisionPct, envio_unitario: eco.envio_unitario,
      });
      const contribucion = econ.contribucion;
      const be = econ.roas_breakeven;

      // ── Histórico: cómo le fue cuando sí se anunciaba ──
      const gruposPropios = c.grupos.map(id => gruposHist.get(id)).filter(Boolean);
      const apiHist = sumarGrupos(gruposPropios, parteDelGrupo);
      const local = histLocal.get(up(p.sku));
      const hist = {
        impresiones: Math.round(apiHist.impresiones + (local?.impresiones || 0)),
        clics: Math.round(apiHist.clics + (local?.clics || 0)),
        inversion: r2(apiHist.inversion + (local?.inversion || 0)),
        facturacion: r2(apiHist.facturacion + (local?.facturacion || 0)),
        unidades: Math.round((apiHist.unidades_exactas ?? apiHist.unidades) + (local?.unidades || 0)),
        desde: local?.primer_dia || (gruposPropios.length ? rangoHist.desde : null),
        hasta: gruposPropios.length ? rangoHist.hasta : (local?.ultimo_dia || null),
        fuente: gruposPropios.length && local ? 'ambas' : gruposPropios.length ? 'api' : local ? 'local' : null,
        campanas: [...new Set([
          ...gruposPropios.map(g => g.campaign_name).filter(Boolean),
          ...(local ? [...local.campanas] : []),
        ])],
        dias_locales: local ? local.dias.size : 0,
      };
      const tuvoAds = hist.inversion > 0 || hist.clics > 0;
      hist.roas = hist.inversion > 0 ? r2(hist.facturacion / hist.inversion) : 0;
      hist.cpc = hist.clics > 0 ? r2(hist.inversion / hist.clics) : 0;
      hist.cvr = hist.clics > 0 ? r2((hist.unidades / hist.clics) * 100) : 0;
      // Ganancia que habría dejado ese gasto con el margen de hoy. El snapshot no guarda el
      // costo de entonces, así que queda dicho con qué contribución está valorizado.
      hist.ganancia = tuvoAds && contribucion > 0 ? r2(contribucion * hist.unidades - hist.inversion) : null;

      // Veredicto del histórico contra el ROAS de equilibrio de hoy.
      let veredictoHist = null;
      if (tuvoAds && hist.inversion > 0 && be != null) {
        veredictoHist = hist.unidades === 0 ? 'no_vendio'
          : hist.roas >= be * 1.15 ? 'rentable'
          : hist.roas >= be ? 'al_filo'
          : 'perdia';
      }

      // La conversión con la que se estima el CPC máximo: la propia si tiene clics
      // suficientes para que signifique algo, si no la de la cuenta.
      const cvrPropio = hist.clics >= UMBRALES.clics_min_cvr_propio ? hist.cvr : null;
      const cvrRef = cvrPropio != null && cvrPropio > 0 ? cvrPropio : cvrCuenta;
      const cvrOrigen = cvrPropio != null && cvrPropio > 0 ? 'propio' : 'cuenta';

      const cpcMax = cvrRef > 0 && contribucion > 0 ? r2(contribucion * (cvrRef / 100)) : null;
      const cpaEstimado = cvrRef > 0 && cpcCuenta > 0 ? r2(cpcCuenta / (cvrRef / 100)) : null;
      // Lo que quedaría limpio de cada venta que trajera ads, al precio de clic de hoy.
      const gananciaPorVenta = cpaEstimado == null ? null : r2(contribucion - cpaEstimado);
      const colchonClic = cpcMax == null ? null : r2(cpcMax - cpcCuenta);

      const d = demanda.get(up(p.sku)) || { meli: 0, total: 0 };
      const unidadesMes = r2((d.meli / diasVentana) * 30);
      const rotacionMensual = unidadesMes;
      const mesesStock = rotacionMensual > 0 ? r2(stockDep / rotacionMensual) : null;

      // Lo que se anuncia ahora, para la rama de ajuste.
      // En qué campañas está corriendo. Con una sola campaña daba igual; con dos, saber
      // si un producto está en las dos es la diferencia entre escalarlo y estar pagando
      // dos veces por el mismo tráfico.
      const campanasActivas = [...new Set(
        c.activos.map(id => gruposRecientes.get(id)?.campaign_name).filter(Boolean)
      )];

      const ahora = sumarGrupos(c.activos.map(id => gruposRecientes.get(id)).filter(Boolean), parteDelGrupo);
      // Con cuántos SKU comparte el anuncio más grande que lo toca. En 1 el anuncio es
      // suyo entero; arriba de 1 los números de abajo son su parte, no el total.
      const compartidoCon = Math.max(1, ...[...c.grupos, ...c.activos].map(skusDelGrupo));
      ahora.roas = ahora.inversion > 0 ? r2(ahora.facturacion / ahora.inversion) : 0;
      ahora.inversion = r2(ahora.inversion);
      ahora.facturacion = r2(ahora.facturacion);
      // Muestra suficiente para juzgar: o gastó más de una contribución entera o juntó
      // clics como para que el silencio signifique algo.
      const juzgable = ahora.clics >= UMBRALES.clics_para_juzgar
        || (contribucion > 0 && ahora.inversion >= contribucion);

      // ── Las reglas ──────────────────────────────────────────────────────────────
      // La primera que encaja manda; el resto quedan como motivos secundarios, porque un
      // producto puede estar mal por más de una razón y quedarse con la primera esconde
      // la mitad del problema.
      const reglas = [];
      const nombre = p.nombre || pub?.titulo || p.sku;

      if (be == null) {
        reglas.push({
          familia: anunciado ? 'ajustar' : 'anunciar', motivo: 'sin_margen',
          accion: anunciado ? 'Pausar y revisar el precio' : 'No anunciar',
          urgencia: anunciado ? 'alta' : 'baja',
          detalle: `A ${r2(precio)} no queda nada: costo ${r2(costo)} + comisión ${comisionPct}%`
            + (eco.envio_unitario ? ` + envío ${eco.envio_unitario}` : '')
            + ` se comen el precio entero. Ningún ROAS lo salva.`,
          plata: ahora.inversion,
        });
      }

      if (anunciado) {
        // Dos campañas con el mismo producto son dos anuncios tuyos en la misma subasta:
        // se suben el CPC entre ellos y el presupuesto se parte sin que nadie lo decida.
        // Es lo primero que hay que mirar después de armar una campaña de winners a partir
        // de otra, porque los winners suelen quedar en las dos.
        if (campanasActivas.length > 1) {
          reglas.push({
            familia: 'ajustar', motivo: 'en_varias_campanas', accion: 'Dejarlo en una sola',
            urgencia: 'alta',
            detalle: `Está corriendo en ${campanasActivas.length} campañas a la vez`
              + ` (${campanasActivas.join(' y ')}). Son dos anuncios tuyos compitiendo en la`
              + ` misma subasta: te suben el CPC entre ellos y parten el presupuesto.`,
            plata: ahora.inversion,
          });
        }
        if (stockPub <= 0) {
          reglas.push({
            familia: 'ajustar', motivo: 'anunciado_sin_stock', accion: 'Pausar ya', urgencia: 'alta',
            detalle: `Gastaste ${ahora.inversion} en ads de una publicación sin stock en MELI.`,
            plata: ahora.inversion,
          });
        }
        if (be != null && juzgable && ahora.roas > 0 && ahora.roas < be) {
          const perdido = r2(ahora.inversion - contribucion * ahora.unidades);
          reglas.push({
            familia: 'ajustar', motivo: 'perdiendo', accion: 'Pausar o bajar la puja', urgencia: 'alta',
            detalle: `ROAS ${ahora.roas.toFixed(2)}x contra un equilibrio de ${be.toFixed(2)}x.`
              + (perdido > 0 ? ` Lleva ${perdido} perdidos en el período.` : ' Está apenas por debajo.'),
            plata: Math.max(0, perdido),
          });
        }
        if (be != null && juzgable && ahora.unidades === 0 && ahora.inversion > 0) {
          reglas.push({
            familia: 'ajustar', motivo: 'quema_sin_vender', accion: 'Revisar la publicación', urgencia: 'alta',
            detalle: `${ahora.clics} clics y ${ahora.inversion} gastados sin una sola venta.`
              + ` El tráfico llega y no compra: precio, fotos o ficha.`,
            plata: ahora.inversion,
          });
        }
        if (be != null && ahora.roas >= be * UMBRALES.holgura_escalar && ahora.unidades > 0 && stockPub > 0) {
          reglas.push({
            familia: 'ajustar', motivo: 'escalar', accion: 'Subir presupuesto', urgencia: 'media',
            detalle: `ROAS ${ahora.roas.toFixed(2)}x contra un equilibrio de ${be.toFixed(2)}x:`
              + ` cada peso de ads deja ${r2(econ.margen_pct / 100 * ahora.roas - 1)} limpios.`
              + ` Hay ${stockPub} unidades publicadas para sostenerlo.`,
            plata: r2(contribucion * ahora.unidades - ahora.inversion),
          });
        }
      } else if (be != null) {
        // ── No se está anunciando: por qué, y si conviene ──
        // Un pausado se reactiva en un click; uno que salió de la campaña hay que volver a
        // agregarlo; uno que nunca estuvo es terreno nuevo.
        const pausados = c.grupos.filter(id => gruposRecientes.has(id));
        const motivoFuera = pausados.length ? 'pausado'
          : c.grupos.length || tuvoAds ? 'salio_de_campana'
          : 'nunca_anunciado';

        const comoLlego = motivoFuera === 'pausado' ? 'El anuncio existe pero está pausado.'
          : motivoFuera === 'salio_de_campana' ? 'Estuvo anunciándose y ya no está en la campaña.'
          : 'Nunca se anunció.';

        if (stockPub <= 0) {
          // No entra como oportunidad, pero tampoco se esconde: es stock que falta reponer.
          reglas.push({
            familia: 'anunciar', motivo: 'sin_stock_para_anunciar', accion: 'Reponer antes de anunciar',
            urgencia: 'baja',
            detalle: `${comoLlego} Deja ${contribucion} por venta, pero la publicación está en cero.`,
            plata: 0,
          });
        } else if (veredictoHist === 'perdia' || veredictoHist === 'no_vendio') {
          reglas.push({
            familia: 'anunciar', motivo: 'ya_fallo', accion: 'No volver sin cambiar algo', urgencia: 'baja',
            detalle: `${comoLlego} Cuando se anunciaba invirtió ${hist.inversion}`
              + (veredictoHist === 'no_vendio'
                  ? ' y no vendió una sola unidad.'
                  : ` a ROAS ${hist.roas.toFixed(2)}x, debajo del equilibrio de ${be.toFixed(2)}x.`)
              + ' Volver a prenderlo sin tocar precio ni publicación repite el resultado.',
            plata: 0,
          });
        } else if (gananciaPorVenta != null && gananciaPorVenta <= 0) {
          reglas.push({
            familia: 'anunciar', motivo: 'no_paga_el_clic', accion: 'Arreglar el precio primero', urgencia: 'baja',
            detalle: `${comoLlego} Traer una venta cuesta ${cpaEstimado} al CPC de la cuenta`
              + ` y el producto sólo deja ${contribucion}. Cada venta por ads perdería ${r2(-gananciaPorVenta)}.`,
            plata: 0,
          });
        } else if (veredictoHist === 'rentable') {
          reglas.push({
            familia: 'anunciar', motivo: 'se_apago_y_andaba', accion: 'Volver a prenderlo', urgencia: 'alta',
            detalle: `${comoLlego} Cuando corría invirtió ${hist.inversion} a ROAS ${hist.roas.toFixed(2)}x`
              + ` (equilibrio ${be.toFixed(2)}x) y vendió ${hist.unidades} unidades`
              + (hist.fuente === 'local' || hist.fuente === 'ambas' ? ', contando el histórico guardado' : '')
              + '.',
            plata: r2(Math.max(0, (gananciaPorVenta || 0) * unidadesMes)),
          });
        } else if (d.meli > 0) {
          reglas.push({
            familia: 'anunciar', motivo: 'ganador_sin_anunciar', accion: 'Empezar a anunciar', urgencia: 'alta',
            detalle: `${comoLlego} Vendió ${d.meli} unidades sin un peso de publicidad,`
              + ` con ${econ.margen_pct}% de margen. Se vende solo: con ads debería vender más.`,
            plata: r2(Math.max(0, (gananciaPorVenta || contribucion) * unidadesMes)),
          });
        } else {
          reglas.push({
            familia: 'anunciar', motivo: 'para_probar', accion: 'Probar con poco', urgencia: 'baja',
            detalle: `${comoLlego} ${econ.margen_pct}% de margen y aguanta hasta ${contribucion}`
              + ` por venta: con ${be.toFixed(2)}x de ROAS ya empata.`
              + (cpcMax != null ? ` Podés pagar hasta ${cpcMax} por clic.` : ''),
            plata: r2(Math.max(0, gananciaPorVenta || 0)),
          });
        }

        // Stock dormido: no cambia qué hacer, pero sí la urgencia de hacerlo.
        if (mesesStock != null && mesesStock >= UMBRALES.meses_stock_dormido && stockDep > 0) {
          reglas.push({
            familia: 'anunciar', motivo: 'stock_dormido', accion: 'Anunciar para rotar', urgencia: 'media',
            detalle: `${stockDep} unidades en el depósito y ${mesesStock} meses de stock al ritmo actual.`
              + ` Cada venta deja ${contribucion}: ads lo mueve más rápido que esperar.`,
            plata: r2(contribucion * stockDep),
          });
        }
      }

      if (be != null && be > UMBRALES.roas_be_inviable) {
        reglas.push({
          familia: anunciado ? 'ajustar' : 'anunciar', motivo: 'margen_flaco',
          accion: anunciado ? 'Subir precio o apagar' : 'Arreglar el precio antes de anunciar',
          urgencia: anunciado ? 'media' : 'baja',
          detalle: `Haría falta ROAS ${be.toFixed(2)}x para empatar, muy por encima de lo que`
            + ` rinde la cuenta. Con ${econ.margen_pct}% de margen, ads no cierra.`,
          plata: ahora.inversion,
        });
      }

      if (!reglas.length) continue;

      const peso = { alta: 3, media: 2, baja: 1 };
      reglas.sort((a, b) => (peso[b.urgencia] - peso[a.urgencia]) || (b.plata - a.plata));
      const principal = reglas[0];

      filas.push({
        sku: p.sku,
        nombre,
        grupo: p.grupo || null,
        meli_id: pub?.meli_id || c.ids[0] || null,
        permalink: pub?.permalink || null,
        thumbnail: pub?.thumbnail || null,
        estado_publicacion: pub?.estado || null,
        publicaciones: suyas.length,

        precio: r2(precio),
        costo: r2(costo),
        comision_pct: r2(comisionPct),
        envio_unitario: eco.envio_unitario,
        economia_fuente: comisionOverride ? 'manual' : eco.fuente,
        contribucion,
        margen: econ.margen_pct,
        roas_breakeven: be,

        stock: stockPub,
        stock_dep: stockDep,
        meses_stock: mesesStock,
        unidades_meli_periodo: d.meli,
        unidades_mes: unidadesMes,

        anunciado,
        campanas_activas: campanasActivas,
        ad_groups: c.grupos,
        // En 1 el anuncio es de este producto solo. Arriba de 1, los números de ads son
        // su parte del anuncio compartido, no el total que muestra el panel de MELI.
        compartido_con: compartidoCon,
        ads_ahora: anunciado ? ahora : null,
        historico: tuvoAds ? hist : null,
        veredicto_historico: veredictoHist,

        cpc_referencia: r2(cpcCuenta),
        cvr_referencia: r2(cvrRef),
        cvr_origen: cvrOrigen,
        cpc_max: cpcMax,
        cpa_estimado: cpaEstimado,
        ganancia_por_venta: gananciaPorVenta,
        colchon_clic: colchonClic,

        familia: principal.familia,
        motivo: principal.motivo,
        accion: principal.accion,
        urgencia: principal.urgencia,
        detalle: principal.detalle,
        plata_en_juego: principal.plata,
        score: r2(peso[principal.urgencia] * 1e6 + Math.min(principal.plata, 999999)),
        otros_motivos: reglas.slice(1).map(r => ({ motivo: r.motivo, detalle: r.detalle })),
      });
    }

    filas.sort((a, b) => b.score - a.score);
    const mostradas = filas.slice(0, limite);

    const porMotivo = {};
    for (const f of filas) {
      if (!porMotivo[f.motivo]) porMotivo[f.motivo] = { motivo: f.motivo, familia: f.familia, productos: 0, plata: 0 };
      porMotivo[f.motivo].productos += 1;
      porMotivo[f.motivo].plata = r2(porMotivo[f.motivo].plata + f.plata_en_juego);
    }

    return res.json({
      ok: true,
      periodo: { desde: rango.desde, hasta: rango.hasta, dias: diasPeriodo },
      periodo_historico: { desde: rangoHist.desde, hasta: rangoHist.hasta, dias: diasHist },
      recortado: rango.recortado,
      currency: ctx.currency,
      economia: {
        comision_pct: comisionOverride ?? economia.global.comision_pct,
        comision_es_manual: comisionOverride != null,
        envio_unitario: economia.global.envio_unitario,
        envios: economia.envios,
        ventas_muestra: economia.global.ventas,
      },
      referencia: {
        campanas: campanas.length,
        clics: refCuenta.clics,
        inversion: r2(refCuenta.inversion),
        unidades: refCuenta.unidades,
        cpc: r2(cpcCuenta),
        cvr: r2(cvrCuenta),
        cpa: cpaCuenta == null ? null : r2(cpaCuenta),
        ad_groups: gruposHist.size,
        anuncios_activos: [...gruposRecientes.values()].filter(g => up(g.status) === 'ACTIVE').length,
      },
      umbrales: UMBRALES,
      resumen: {
        catalogo: (productos || []).length,
        evaluados: evaluables.length,
        con_recomendacion: filas.length,
        mostrados: mostradas.length,
        anunciados: filas.filter(f => f.anunciado).length,
        sin_anunciar: filas.filter(f => !f.anunciado).length,
        con_historico: filas.filter(f => f.historico).length,
        descartados,
        por_motivo: Object.values(porMotivo).sort((a, b) => b.plata - a.plata),
        // El snapshot es lo único que recuerda más allá de los 90 días de MELI. Si no se
        // pudo leer, el histórico de un producto apagado hace meses sale vacío y eso
        // cambia lo que la sección puede afirmar.
        snapshot_historico: snapshotDisponible,
        // Si no se pudo leer una campaña entera, algún producto puede aparecer como "sin
        // anunciar" estando anunciado. Vale decirlo antes que mostrar una lista que
        // parece completa.
        incompleto: incompleto.length ? incompleto : null,
      },
      recomendaciones: mostradas,
    });

  } catch (err) {
    console.error('Error en ads-recomendaciones.js:', err);
    return res.status(500).json({ ok: false, error: err.message, detalle: err.detalle });
  }
};

// El reparto de un anuncio entre las variantes que lo comparten es la aritmética que
// decide cuánta plata se le atribuye a cada producto; se expone para poder probarla sin
// levantar el endpoint ni hablar con MELI.
module.exports.sumarGrupos = sumarGrupos;
