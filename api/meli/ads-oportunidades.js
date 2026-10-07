// api/meli/ads-oportunidades.js
// GET /api/meli/ads-oportunidades?dias=30&historico_dias=90&comision=15&limite=40
//
// La otra mitad de la pestaña de Ads: la tabla de anuncios dice qué hacer con lo que ya se
// está anunciando, y esto dice qué FALTA anunciar. Busca productos del CRM que hoy no
// tienen ningún anuncio corriendo y que, por su margen, podrían pagar los clics y dejar
// plata si lo tuvieran.
//
// Cómo decide que un producto "no se está anunciando": junta los ad groups de todas las
// campañas de Product Ads en el período y los resuelve a item_ids. Un producto cuyas
// publicaciones no aparecen en ningún ad group ACTIVO queda como candidato. Las tres formas
// de quedar afuera de los ads se distinguen, porque no se juzgan igual:
//   · nunca_anunciado   → no aparece en la ventana de MELI (90 días) ni en el histórico local.
//   · pausado           → el anuncio existe en la campaña pero está pausado: se reactiva y listo.
//   · salio_de_campana  → estuvo anunciándose en la ventana y ya no está.
//
// El pedido explícito sobre los que ya estuvieron: antes de recomendar volver a anunciar un
// producto hay que mirar cómo le fue cuando sí se anunciaba. Eso sale de dos lados y se
// suman sin pisarse:
//   · MELI en vivo: las métricas del ad group en los días del rango histórico (90 días es
//     todo lo que la API sirve).
//   · meli_ads_anuncios: el snapshot diario local, que es lo único que queda de lo anterior
//     a esos 90 días. Sólo se suman los días ANTERIORES a la ventana de la API, así que un
//     día capturado en los dos lados no se cuenta dos veces.
// Con eso se calcula el ROAS que el producto tuvo en ads y se lo compara contra su ROAS de
// equilibrio de HOY (con el costo y el precio de hoy): un producto que perdía plata cuando
// se anunciaba vuelve a la lista marcado en rojo, no como oportunidad.

const { getSupabase } = require('../_supabase');
const { getAdsContext, adsGet, resolverRango, enLotes, API, aFecha, sumarDias } = require('./_adsClient');
const { meliIdsDe } = require('../_meliIds');

// El search de ad groups toma las métricas en MAYÚSCULAS (el de campañas, en minúsculas).
const METRICS_AD_GROUP = [
  'CLICKS', 'PRINTS', 'COST', 'TOTAL_AMOUNT', 'UNITS_QUANTITY',
].join(',');
const METRICS_CAMPANA = 'clicks,prints,cost,cpc,ctr,cvr,units_quantity,total_amount,roas';

const COMISION_DEFAULT = 15;     // la misma que usa procesar-orden-meli para valorizar ventas
const HISTORICO_DIAS = 90;       // todo lo que MELI sirve hacia atrás
const LIMITE_DEFAULT = 40;
const CONCURRENCIA = 8;
const PAGINA = 200;
const MAX_AD_GROUPS = 600;
const LOTE_ITEMS = 20;           // tope del multiget de /items
// Debajo de esta cantidad de clics, la conversión histórica del producto es ruido y se usa
// la de la cuenta: con 3 clics y una venta daría 33% y el CPC máximo saldría absurdo.
const CLICS_MIN_CVR_PROPIO = 20;
// Estados de publicación que pueden recibir tráfico de ads.
const ESTADO_ANUNCIABLE = 'active';

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const ent = v => (v === null || v === undefined ? 0 : parseInt(v, 10) || 0);
const r2 = v => Math.round(v * 100) / 100;
const up = v => String(v || '').trim().toUpperCase();

/**
 * Todos los ad groups de una campaña en el rango, paginando hasta agotar.
 * Devuelve { grupos, truncado }: cortar en el tope sin avisar haría aparecer como
 * "sin anunciar" a productos que sí tienen anuncio, que es el peor error posible acá.
 */
async function traerGrupos(ctx, campaignId, desde, hasta) {
  const url = (offset) =>
    `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/ad_groups/search`
    + `?date_from=${desde}&date_to=${hasta}`
    + `&metrics=${METRICS_AD_GROUP}&metrics_summary=true`
    + `&limit=${PAGINA}&offset=${offset}&sort=desc&sort_by=cost`
    // Singular: trae todo lo que ESTUVO en la campaña durante el rango. Con el plural
    // (filters[campaigns]) se perdería justo lo que acá interesa, los que ya salieron.
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
  return { grupos, truncado, error, total };
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

/** Estado, precio y stock de cada publicación, por multiget de /items. */
async function traerPublicaciones(ctx, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
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

/** Suma de métricas de ad groups (las del search vienen en minúsculas dentro de `metrics`). */
function sumarGrupos(grupos) {
  const t = { impresiones: 0, clics: 0, inversion: 0, facturacion: 0, unidades: 0 };
  for (const g of grupos) {
    const m = g.metrics || {};
    t.impresiones += ent(m.prints);
    t.clics += ent(m.clicks);
    t.inversion += num(m.cost);
    t.facturacion += num(m.total_amount);
    t.unidades += ent(m.units_quantity);
  }
  return t;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const comisionPct = num(req.query.comision) || COMISION_DEFAULT;
  const limite = Math.max(1, ent(req.query.limite) || LIMITE_DEFAULT);
  const rango = resolverRango(req.query);
  if (rango.vacio) {
    return res.json({ ok: false, error: `Rango vacío: ${rango.desde} es posterior a ${rango.hasta}.` });
  }
  // Ventana del histórico: lo más atrás que MELI contesta.
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

    // ── 1. Las campañas y la referencia de la cuenta ──────────────────────────────
    // El CPC y la conversión promedio de lo que YA se anuncia son la única vara para
    // estimar qué le costaría a un producto nuevo traer una venta por ads.
    const camp = await adsGet(
      `${API}/advertising/${ctx.siteId}/advertisers/${ctx.advertiserId}/product_ads/campaigns/search`
      + `?date_from=${rango.desde}&date_to=${rango.hasta}&metrics=${METRICS_CAMPANA}&limit=200&offset=0`,
      ctx.headers
    );
    if (!camp.ok) {
      return res.json({
        ok: false,
        error: `Error ${camp.status} al pedir las campañas a MELI`,
        detalle: camp.body,
      });
    }
    const campanas = (camp.body.results || []).map(c => ({ id: String(c.id), nombre: c.name || `Campaña ${c.id}`, status: c.status, metrics: c.metrics || {} }));

    const refCuenta = campanas.reduce((a, c) => {
      a.clics += ent(c.metrics.clicks);
      a.inversion += num(c.metrics.cost);
      a.unidades += ent(c.metrics.units_quantity);
      a.facturacion += num(c.metrics.total_amount);
      return a;
    }, { clics: 0, inversion: 0, unidades: 0, facturacion: 0 });

    const cpcCuenta = refCuenta.clics > 0 ? refCuenta.inversion / refCuenta.clics : 0;
    const cvrCuenta = refCuenta.clics > 0 ? (refCuenta.unidades / refCuenta.clics) * 100 : 0;
    // Lo que cuesta hoy una venta traída por ads. Es la vara contra la que se mide la
    // contribución de cada producto: si deja menos que esto, el clic no se paga.
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

    const itemIds = await itemIdsDeGrupos(ctx, gruposHist.keys());

    // Publicación → ad groups que la anuncian. Una publicación puede estar en más de un
    // ad group (una campaña por objetivo y otra manual, por ejemplo).
    const gruposDeItem = new Map();
    for (const [adGroupId, ids] of itemIds) {
      for (const id of ids) {
        const k = up(id);
        if (!gruposDeItem.has(k)) gruposDeItem.set(k, []);
        gruposDeItem.get(k).push(adGroupId);
      }
    }

    // ── 3. Catálogo del CRM ───────────────────────────────────────────────────────
    const supabase = getSupabase();
    const { data: productos, error: errProd } = await supabase
      .from('productos')
      .select('sku, nombre, grupo, costo, precio, stock_dep, stock_meli, meli_id, meli_ids, discontinuado');
    if (errProd) throw errProd;

    // ── 4. Clasificar cada producto ───────────────────────────────────────────────
    const descartados = {
      discontinuados: 0, sin_publicacion: 0, sin_costo: 0, sin_precio: 0,
      anunciandose: 0, sin_stock: 0, sin_publicacion_activa: 0, sin_margen: 0,
    };

    const candidatos = [];
    for (const p of productos || []) {
      if (p.discontinuado) { descartados.discontinuados++; continue; }

      const ids = meliIdsDe(p);
      if (!ids.length) { descartados.sin_publicacion++; continue; }

      // Los ad groups que tocan alguna de sus publicaciones.
      const propios = [...new Set(ids.flatMap(id => gruposDeItem.get(up(id)) || []))];
      const activos = propios.filter(id => up(gruposRecientes.get(id)?.status) === 'ACTIVE');
      if (activos.length) { descartados.anunciandose++; continue; }

      if (num(p.costo) <= 0) { descartados.sin_costo++; continue; }

      candidatos.push({ producto: p, ids, grupos: propios });
    }

    // ── 5. Estado real de las publicaciones de los candidatos ─────────────────────
    // El CRM puede tener stock y la publicación estar pausada o sin stock en MELI: anunciar
    // eso es tirar la plata, así que se mira la publicación antes de recomendarla.
    const pubs = await traerPublicaciones(ctx, candidatos.flatMap(c => c.ids));

    // ── 6. Demanda propia: lo que el producto vende sin ads ───────────────────────
    const { data: ventas, error: errVentas } = await supabase
      .from('ventas')
      .select('sku, cantidad, canal, fecha')
      .gte('fecha', rangoHist.desde);
    if (errVentas) throw errVentas;

    const demanda = new Map();   // sku → { meli, total }
    for (const v of ventas || []) {
      const k = up(v.sku);
      if (!k) continue;
      if (!demanda.has(k)) demanda.set(k, { meli: 0, total: 0 });
      const d = demanda.get(k);
      const cant = ent(v.cantidad);
      d.total += cant;
      if (v.canal === 'meli') d.meli += cant;
    }

    // ── 7. Histórico local de ads, lo único que sobrevive a los 90 días ───────────
    const skusCandidatos = [...new Set(candidatos.map(c => c.producto.sku).filter(Boolean))];
    const histLocal = new Map();   // sku → totales de los días anteriores a la ventana de la API
    if (skusCandidatos.length) {
      const { data: snaps, error: errSnap } = await supabase
        .from('meli_ads_anuncios')
        .select('fecha, sku, ad_group_id, campaign_name, impressions, clicks, spend, facturacion, unidades')
        .in('sku', skusCandidatos);
      if (errSnap) {
        // Que no exista el snapshot todavía no puede tumbar la sección: el histórico de la
        // API ya cubre los 90 días y es la fuente principal.
        console.error('ads-oportunidades: no se pudo leer meli_ads_anuncios:', errSnap.message);
      }
      for (const s of snaps || []) {
        // Los días que la API ya contestó no se suman de nuevo.
        if (s.fecha >= rangoHist.desde) continue;
        const k = up(s.sku);
        if (!histLocal.has(k)) {
          histLocal.set(k, {
            impresiones: 0, clics: 0, inversion: 0, facturacion: 0, unidades: 0,
            dias: new Set(), primer_dia: s.fecha, ultimo_dia: s.fecha, campanas: new Set(),
          });
        }
        const h = histLocal.get(k);
        h.impresiones += ent(s.impressions);
        h.clics += ent(s.clicks);
        h.inversion += num(s.spend);
        h.facturacion += num(s.facturacion);
        h.unidades += ent(s.unidades);
        h.dias.add(s.fecha);
        if (s.fecha < h.primer_dia) h.primer_dia = s.fecha;
        if (s.fecha > h.ultimo_dia) h.ultimo_dia = s.fecha;
        if (s.campaign_name) h.campanas.add(s.campaign_name);
      }
    }

    // ── 8. Armado de filas ────────────────────────────────────────────────────────
    const diasVentana = Math.max(
      1,
      Math.round((new Date(rangoHist.hasta) - new Date(rangoHist.desde)) / 86400000) + 1
    );
    const filas = [];
    for (const c of candidatos) {
      const p = c.producto;

      // La publicación que va a recibir el tráfico: la activa con más stock. Si ninguna
      // está activa, el producto no es anunciable hoy y se dice por qué.
      const suyas = c.ids.map(id => pubs.get(String(id))).filter(Boolean);
      const anunciables = suyas.filter(x => x.estado === ESTADO_ANUNCIABLE);
      if (suyas.length && !anunciables.length) { descartados.sin_publicacion_activa++; continue; }
      const conStock = anunciables.filter(x => (x.stock ?? 0) > 0);
      if (anunciables.length && !conStock.length) { descartados.sin_stock++; continue; }
      const pub = conStock.sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0))[0] || null;

      // Sin publicación leída (MELI no contestó) se cae al dato del CRM antes que descartar.
      const precio = num(pub?.precio) || num(p.precio);
      const stockPub = pub?.stock ?? ent(p.stock_meli);
      if (precio <= 0) { descartados.sin_precio++; continue; }
      if (stockPub <= 0) { descartados.sin_stock++; continue; }

      // Economía, con las mismas cuentas que la tabla de anuncios para que los dos
      // números se puedan comparar de una pestaña a la otra.
      const costo = num(p.costo);
      const comision = precio * (comisionPct / 100);
      const contribucion = precio - costo - comision;
      const margen = (contribucion / precio) * 100;
      if (contribucion <= 0) { descartados.sin_margen++; continue; }

      // ── Histórico: cómo le fue cuando sí se anunciaba ──
      const gruposPropios = c.grupos.map(id => gruposHist.get(id)).filter(Boolean);
      const apiHist = sumarGrupos(gruposPropios);
      const local = histLocal.get(up(p.sku));
      const hist = {
        impresiones: apiHist.impresiones + (local?.impresiones || 0),
        clics: apiHist.clics + (local?.clics || 0),
        inversion: r2(apiHist.inversion + (local?.inversion || 0)),
        facturacion: r2(apiHist.facturacion + (local?.facturacion || 0)),
        unidades: apiHist.unidades + (local?.unidades || 0),
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
      // costo de entonces, así que se dice con qué contribución está valorizado.
      hist.ganancia = tuvoAds ? r2(contribucion * hist.unidades - hist.inversion) : null;

      // Por qué está afuera de los ads. Un pausado se reactiva en un click; uno que salió
      // de la campaña hay que volver a agregarlo; uno que nunca estuvo es terreno nuevo.
      const pausados = c.grupos.filter(id => gruposRecientes.has(id));
      const motivo = pausados.length ? 'pausado'
        : c.grupos.length ? 'salio_de_campana'
        : tuvoAds ? 'salio_de_campana'
        : 'nunca_anunciado';

      const roasBreakeven = r2(100 / margen);

      // La conversión con la que se estima el CPC máximo. La propia del producto si tiene
      // clics suficientes para que signifique algo; si no, la de la cuenta.
      const cvrPropio = hist.clics >= CLICS_MIN_CVR_PROPIO ? hist.cvr : null;
      const cvrRef = cvrPropio != null && cvrPropio > 0 ? cvrPropio : cvrCuenta;
      const cvrOrigen = cvrPropio != null && cvrPropio > 0 ? 'propio' : 'cuenta';

      const cpcMax = cvrRef > 0 ? r2(contribucion * (cvrRef / 100)) : null;
      const cpaEstimado = cvrRef > 0 && cpcCuenta > 0 ? r2(cpcCuenta / (cvrRef / 100)) : null;
      // Lo que quedaría limpio de cada venta que trajera ads, al precio de clic de hoy.
      const gananciaPorVenta = cpaEstimado == null ? null : r2(contribucion - cpaEstimado);
      const colchonClic = cpcMax == null ? null : r2(cpcMax - cpcCuenta);

      // Demanda probada: lo que el producto ya vende sin que nadie lo empuje.
      const d = demanda.get(up(p.sku)) || { meli: 0, total: 0 };
      const unidadesMes = r2((d.meli / diasVentana) * 30);

      // Escala de la oportunidad: la ganancia por venta por las ventas que el producto ya
      // hace solo en un mes. No es una promesa de ventas nuevas — es la vara de cuánto
      // mueve este producto, para ordenar la lista por lo que vale la pena mirar primero.
      const potencial = gananciaPorVenta != null && gananciaPorVenta > 0 ? r2(gananciaPorVenta * unidadesMes) : 0;

      // Veredicto del histórico contra el ROAS de equilibrio de hoy.
      let veredictoHist = null;
      if (tuvoAds && hist.inversion > 0) {
        veredictoHist = hist.unidades === 0 ? 'no_vendio'
          : hist.roas >= roasBreakeven * 1.15 ? 'rentable'
          : hist.roas >= roasBreakeven ? 'al_filo'
          : 'perdia';
      }

      // Recomendación. El histórico manda sobre la estimación: si cuando se anunciaba
      // perdía plata, la estimación optimista no alcanza para recomendarlo de nuevo.
      const recomendacion =
        veredictoHist === 'perdia' || veredictoHist === 'no_vendio' ? 'ya_fallo'
        : gananciaPorVenta != null && gananciaPorVenta <= 0 ? 'no_paga_el_clic'
        : veredictoHist === 'rentable' ? 'volver_a_anunciar'
        : unidadesMes > 0 ? 'vale_la_pena'
        : 'para_probar';

      filas.push({
        sku: p.sku,
        nombre: p.nombre || pub?.titulo || p.sku,
        grupo: p.grupo || null,
        titulo_publicacion: pub?.titulo || null,
        meli_id: pub?.meli_id || c.ids[0] || null,
        meli_ids: c.ids,
        publicaciones: suyas.length,
        permalink: pub?.permalink || null,
        thumbnail: pub?.thumbnail || null,
        estado_publicacion: pub?.estado || null,
        stock: stockPub,
        stock_dep: ent(p.stock_dep),
        vendidas_historico_meli: pub?.vendidas ?? null,
        precio: r2(precio),
        costo: r2(costo),
        comision: r2(comision),
        comision_pct: comisionPct,
        contribucion: r2(contribucion),
        margen: r2(margen),
        roas_breakeven: roasBreakeven,
        cpa_max: r2(contribucion),
        cpc_max: cpcMax,
        cpc_referencia: r2(cpcCuenta),
        cvr_referencia: r2(cvrRef),
        cvr_origen: cvrOrigen,
        cpa_estimado: cpaEstimado,
        ganancia_por_venta: gananciaPorVenta,
        colchon_clic: colchonClic,
        unidades_meli_periodo: d.meli,
        unidades_totales_periodo: d.total,
        unidades_mes: unidadesMes,
        potencial_mes: potencial,
        motivo,
        ad_groups: c.grupos,
        historico: tuvoAds ? hist : null,
        veredicto_historico: veredictoHist,
        recomendacion,
      });
    }

    // Primero lo que más plata puede mover; los que todavía no venden nada quedan abajo,
    // ordenados por lo que dejaría cada venta.
    filas.sort((a, b) =>
      (b.potencial_mes - a.potencial_mes) ||
      ((b.ganancia_por_venta ?? -Infinity) - (a.ganancia_por_venta ?? -Infinity)) ||
      (b.contribucion - a.contribucion)
    );

    const mostradas = filas.slice(0, limite);

    return res.json({
      ok: true,
      periodo: { desde: rango.desde, hasta: rango.hasta },
      periodo_historico: { desde: rangoHist.desde, hasta: rangoHist.hasta, dias: diasHist },
      currency: ctx.currency,
      comision_pct: comisionPct,
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
      totales: {
        productos: (productos || []).length,
        candidatos: filas.length,
        mostrados: mostradas.length,
        potencial_mes: r2(filas.reduce((a, f) => a + f.potencial_mes, 0)),
        con_historico: filas.filter(f => f.historico).length,
        pausados: filas.filter(f => f.motivo === 'pausado').length,
        salieron: filas.filter(f => f.motivo === 'salio_de_campana').length,
        nunca: filas.filter(f => f.motivo === 'nunca_anunciado').length,
        descartados,
        // Si no se pudo leer una campaña entera, algún producto puede aparecer acá estando
        // anunciado. Vale decirlo antes que mostrar una lista que parece completa.
        incompleto: incompleto.length ? incompleto : null,
      },
      oportunidades: mostradas,
    });

  } catch (err) {
    console.error('Error en ads-oportunidades.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
