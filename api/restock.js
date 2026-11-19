// api/restock.js
// GET /api/restock
//
// Returns { lead_time_promedio, lead_time_muestra, lead_time_stdev, lead_time_min,
//           lead_time_max, lead_time_metodo, productos } where each product has:
//   - daily_velocity           = units sold (net of confirmed returns) / active selling days
//                                 (días desde publicación hasta hoy, acotado a DEMAND_WINDOW_DAYS,
//                                 menos tramos confirmados sin stock — NO solo primera venta→última venta)
//   - days_coverage            = current stock / daily_velocity
//   - restock_date             = today + days_coverage − lead_time_promedio (last day to order before stockout)
//   - stockout_date            = today + days_coverage
//   - cobertura_proyectada_dias = (stock + qty_en_transito) / daily_velocity  (total pipeline supply, ignores timing)
//   - punto_pedido_uds         = demanda esperada durante el lead time + stock de seguridad estadístico
//   - safety_stock_uds         = colchón por variabilidad de demanda y de lead time (fórmula de King)
//   - cantidad_sugerida        = units still needed to reach punto_pedido_uds (or alerta_min, lo que sea mayor)
//   - restock_status           = 'quiebre_confirmado' | 'ordenar_ya' | 'insuficiente' | 'proximo'
//                                 | 'cubierto' | 'sin_ventas'
//   - already_ordered          = true if the SKU appears in a non-arrived import (kept for compat)
//   - gap_cierra_fecha         = si hay quiebre_confirmado, fecha en la que el próximo envío lo cierra
//   - agota_con_transito       = fecha en la que se termina el stock actual + todo lo que está en camino
//   - periodos_sin_stock       = tramos dentro de la ventana de ventas donde el stock reconstruido dio 0
//                                 (excluidos de active_days para no diluir la velocidad real)
//
// CRITICAL: sales velocity aggregates ALL channels (meli + mostrador + shopify).
// No channel filter is applied anywhere in this file.
//
// CRITICAL: este endpoint devuelve TODOS los productos activos, siempre — incluidos
// los que no vendieron nada en la ventana de demanda. Antes se descartaban en
// silencio y el calendario mostraba 40 de 70 productos, así que el catálogo
// "completo" de la pantalla no era completo y no había forma de notarlo desde la
// UI. Los que no tienen señal de venta salen con restock_status 'sin_ventas' para
// que el front los muestre en "Todos" sin ensuciar "Hay que comprar".

//
// Clase de compra (api/_clasesCompra.js): cada producto sale además con `clase`
// ('nunca' | 'siempre' | 'nuevo' | 'poco' | 'descatalogar' | 'sin_datos'), el motivo y lo que
// deja (contrib_mes, retorno_100). La clase cambia la meta de reposición: los ⭐ "nunca sin
// stock" se cubren con plazo + 55 días de venta (~5 meses con 95 de plazo), los "siempre" con
// plazo + 25, los de "comprar poco" solo con el plazo y los "descatalogar" no se compran
// (restock_status 'no_comprar'). cantidad_sugerida ya sale con esa meta, así que la compra por proveedor de
// Importaciones la usa sin cambios.

const { getSupabase } = require('./_supabase');
const { todasLasPiezas } = require('./_kits');
const { todasLasFilas } = require('./_paginar');
const { FACTOR_IVA_ADS } = require('./meli/_adsIva');
const C = require('./_clasesCompra');

// Los kits no se compran: se arman con piezas. Una venta (o devolución) de un kit es demanda
// de cada pieza, en unidades de depósito: kits × cantidad de esa pieza en el kit.
// Devuelve [{ sku, uds, ...resto }] con las líneas de kit abiertas en sus piezas; las demás
// pasan con uds = null (las convierte aUnidades como siempre).
function abrirKits(lineas, piezasPorKit) {
  const salida = [];
  for (const l of lineas || []) {
    const piezas = piezasPorKit[l.sku];
    if (!piezas?.length) { salida.push({ ...l, uds: null }); continue; }
    for (const p of piezas) salida.push({ ...l, sku: p.sku, uds: (Number(l.cantidad) || 0) * p.cantidad });
  }
  return salida;
}

const FALLBACK_LEAD_DAYS = 85;
const MS_PER_DAY         = 86400 * 1000;

// Ventana de demanda: cuántos días hacia atrás se miran las ventas para estimar
// la velocidad. Tiene que cubrir holgadamente el lead time (~82 días) — si no, un
// producto que estuvo sin stock la mayor parte de la ventana se queda sin datos
// suficientes y aparece con una velocidad ridículamente baja. Ej. ALERONFINOSNK:
// vendió 11 uds en mayo, se quedó sin stock hasta el 12/09 y volvió a vender 2;
// con una ventana de 90 días las 11 de mayo quedaban afuera y la velocidad daba
// 0.14/día (7 veces menos que la real), así que el producto figuraba "cubierto".
// El denominador ya descuenta los tramos confirmados sin stock (findStockoutPeriods),
// así que estirar la ventana suma ventas reales sin diluir la tasa.
const DEMAND_WINDOW_DAYS = 180;

// Economía de cada producto (para la clase de compra): lo que deja cada unidad se mide con las
// ventas de los últimos ECON_WINDOW_DAYS, que tienen la comisión y el envío de MELI reales y
// los precios de ahora. Si no vendió en ese tramo, se usa toda la ventana de demanda.
const ECON_WINDOW_DAYS = 120;
// Publicidad: % de lo que factura en MELI que se gasta en Ads (con IVA), por producto, del
// snapshot diario meli_ads_anuncios. Sin dato del producto, el promedio de la cuenta
// (meli_ads_diario); sin eso tampoco, ADS_PCT_DEFAULT (el de octubre de 2026).
const ADS_WINDOW_DAYS = 60;
const ADS_PCT_DEFAULT = 0.22;
const normSku = s => String(s || '').trim().toUpperCase();

// ── Modelo de stock de seguridad (fórmula de King: demanda y lead time inciertos) ──
// safety_stock = Z · √( LEAD_DAYS · σ_demanda² + demanda_diaria² · σ_leadtime² )
// Reemplaza el margen fijo (antes: lead_time × 1.15 igual para todos los SKUs) por
// un colchón que crece con la variabilidad real de cada producto y del lead time,
// en vez de tratar a un producto de venta pareja igual que uno errático.
const SERVICE_Z          = 1.28; // ~90% de nivel de servicio (ajustable según tolerancia a quiebres vs. capital inmovilizado)
const DEFAULT_DEMAND_CV  = 0.75; // coef. de variación asumido cuando no hay suficientes días de venta para medirlo empíricamente
const DEFAULT_LT_CV      = 0.30; // ídem para lead time, cuando hay <2 importaciones terminales con datos
const MIN_SPAN_FOR_STDEV = 5;    // días mínimos de ventana real de ventas para confiar en el desvío empírico de demanda
const MIN_DAYS_LOW_SAMPLE = 14;  // piso de días activos cuando la muestra es muy chica (pocas ventas o pocos días
                                  // observados) y la fecha de publicación no alcanza para dar una ventana creíble
const STOCKOUT_TOLERANCE = 1;    // tolerancia al reconstruir stock: acepta hasta -1 (un desajuste chico, ej. una
                                  // venta de mostrador no sincronizada) como "confirmado sin stock"; valores más
                                  // negativos indican un problema de datos más de fondo (ej. una importación vieja
                                  // que no tenemos registrada) y no se usan — ver comentario en findStockoutPeriods

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// Simula la llegada de los envíos pendientes en el tiempo (en vez de sumarlos
// todos como si estuvieran disponibles hoy) para detectar si el stock físico
// se agota ANTES de que llegue el próximo envío. Esto es lo que "cobertura
// total" (stock + tránsito, sin fechas) no puede ver: un pedido de 40 unidades
// que llega en 46 días no tapa que hoy, con stock 0, no se vende nada durante
// esos 46 días.
//
// Devuelve también `agotaFecha`: el día en que, vendiendo a este ritmo, se termina el stock
// actual MÁS todo lo que está en camino. Es lo que explica el "pedí N más" de un producto
// que ya tiene pedido: si los envíos pendientes se agotan antes de lo que tarda en llegar
// una compra nueva (más el colchón), hay que volver a comprar aunque algo venga en camino.
function computeStockoutGap(stock, dailyVelocity, transito, leadTimePromedio, today) {
  if (dailyVelocity <= 0 || !transito.length) return { tieneQuiebre: false, gapCierraFecha: null, agotaFecha: null };

  const events = transito
    .map(t => {
      const days = t.llegada
        ? Math.round((new Date(t.llegada) - today) / MS_PER_DAY)
        : leadTimePromedio; // sin fecha conocida: estimamos con el lead time promedio
      return { day: Math.max(0, days), qty: t.qty || 0, llegada: t.llegada };
    })
    .sort((a, b) => a.day - b.day);

  let currentStock   = stock;
  let currentDay      = 0;
  let tieneQuiebre    = false;
  let gapCierraFecha  = null;

  for (const ev of events) {
    const depleteDay = currentDay + currentStock / dailyVelocity;
    if (depleteDay <= ev.day) {
      // El stock se agota antes de que llegue este envío: hueco confirmado.
      tieneQuiebre = true;
      if (!gapCierraFecha) gapCierraFecha = ev.llegada;
      currentStock = ev.qty;
    } else {
      currentStock = currentStock - dailyVelocity * (ev.day - currentDay) + ev.qty;
    }
    currentDay = ev.day;
  }

  const agotaDia   = currentDay + currentStock / dailyVelocity;
  const agotaFecha = new Date(today.getTime() + agotaDia * MS_PER_DAY).toISOString().slice(0, 10);

  return { tieneQuiebre, gapCierraFecha, agotaFecha };
}

// Reconstruye, hacia atrás desde el stock actual, en qué tramos el producto
// tuvo stock 0 — usando TODO el historial de ventas (restan), llegadas de
// importaciones y devoluciones confirmadas (suman) como los únicos
// movimientos de stock que conocemos, y después recorta el resultado a
// [windowStart, windowEnd]. Es importante usar el historial completo (no solo
// los eventos dentro de la ventana) porque el evento que confirma el tramo en
// 0 puede caer ANTES de windowStart — ej. DFB-002 se vació el 10/03 (fuera de
// cualquier ventana de 90 días) y no volvió a tener stock hasta el 17/07; sin
// mirar esa venta de marzo no hay forma de confirmar que los primeros ~57 días
// de la ventana de 90 días también estuvieron en 0.
//
// Se confía en un tramo como "confirmado sin stock" cuando el nivel
// reconstruido da 0 o -1 (STOCKOUT_TOLERANCE): un desajuste de una sola
// unidad es esperable (una venta de mostrador no sincronizada, un ajuste
// manual chico) y no debería bloquear una detección que en todo lo demás es
// sólida — ej. GZTYJ-41046R da -1, pero GZTYJ-41046N (mismo import, mismo
// lote) da 0 exacto para el mismo hueco, confirmando que es genuino.
// Si da MÁS negativo que eso, hay un problema de datos más de fondo (ej. una
// importación vieja que no tenemos registrada — así se comporta YTLY-30, con
// varios tramos entre -2 y -5) y ese tramo se deja como estaba antes en vez de
// arriesgar un resultado incorrecto.
//
// Stock residual: un tramo largo sin una sola venta con 1 o 2 unidades reconstruidas tampoco
// es demanda baja, si al ritmo del producto se esperaban varias ventas en ese tramo. Es un
// desajuste de conteo (una unidad fallada, una venta que no se registró) y el producto en
// la práctica estaba agotado. ALERONFINOSNK: vendió 11 en mayo, la reconstrucción le deja 1
// unidad hasta que llegan 15 el 12/09, y vende 36 de septiembre a noviembre; contar esos 115
// días como "con stock y sin ventas" le bajaba la velocidad de ~0,7 a 0,22 por día. Solo se
// aplica con `velocidad` (la de la primera pasada, sin este ajuste) y si en el tramo se
// esperaban al menos VENTAS_ESPERADAS_HUECO ventas.
const STOCK_RESIDUAL_MAX    = 2;
const VENTAS_ESPERADAS_HUECO = 5;
function findStockoutPeriods(dailyQtyMap, arrivals, returns, currentStock, windowStart, windowEnd, velocidad = 0) {
  const events = [];
  for (const [fecha, qty] of Object.entries(dailyQtyMap)) {
    if (qty) events.push({ fecha, delta: -qty });
  }
  for (const a of arrivals) {
    if (a.qty && a.fecha) events.push({ fecha: a.fecha, delta: a.qty });
  }
  for (const r of returns) {
    if (r.qty && r.fecha) events.push({ fecha: r.fecha, delta: r.qty });
  }
  if (!events.length) return [];
  events.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));

  // Nivel de stock justo DESPUÉS de cada evento, reconstruido hacia atrás
  // desde el stock actual (deshaciendo los eventos más recientes primero).
  let cumulative = 0;
  const levelAfter = new Array(events.length);
  for (let i = events.length - 1; i >= 0; i--) {
    levelAfter[i] = currentStock - cumulative;
    cumulative += events[i].delta;
  }

  const winStart = new Date(windowStart);
  const winEnd   = new Date(windowEnd);
  const periods = [];
  for (let i = 0; i < events.length - 1; i++) {
    const nivel = levelAfter[i];
    const exacto = nivel <= 0 && nivel >= -STOCKOUT_TOLERANCE;
    let residual = false;
    if (!exacto && velocidad > 0 && nivel > 0 && nivel <= STOCK_RESIDUAL_MAX) {
      const diasHueco = Math.round((new Date(events[i + 1].fecha) - new Date(events[i].fecha)) / MS_PER_DAY) - 1;
      residual = diasHueco * velocidad >= VENTAS_ESPERADAS_HUECO;
    }
    if (exacto || residual) {
      let d1 = new Date(events[i].fecha);
      d1.setDate(d1.getDate() + 1);
      let d2 = new Date(events[i + 1].fecha);
      d2.setDate(d2.getDate() - 1);
      if (d1 < winStart) d1 = winStart;
      if (d2 > winEnd) d2 = winEnd;
      if (d1 <= d2) {
        const dias = Math.round((d2 - d1) / MS_PER_DAY) + 1;
        const per = { desde: d1.toISOString().slice(0, 10), hasta: d2.toISOString().slice(0, 10), dias };
        if (residual) per.quedaban = nivel; // unidades reconstruidas que no se vendieron
        periods.push(per);
      }
    }
  }
  return periods;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();

  try {
    // ── 1. All products ──────────────────────────────────────────────────────
    // proveedor_id (para filtrar la pantalla por proveedor) existe desde la migración de
    // proveedores; si todavía no corrió, se lee sin esa columna en vez de romper Reposición.
    const COLS_PRODUCTO = 'sku, nombre, grupo, subgrupo, stock_dep, unidades_por_venta, tipo, fecha_publicacion, alerta_min, created_at, costo';
    const leerProductos = cols => supabase
      .from('productos')
      .select(cols)
      .neq('tipo', 'usado')
      .or('discontinuado.is.null,discontinuado.eq.false');
    let { data: productosTodos, error: prodErr } = await leerProductos(`${COLS_PRODUCTO}, proveedor_id`);
    if (prodErr && /proveedor_id/.test(prodErr.message || '')) {
      ({ data: productosTodos, error: prodErr } = await leerProductos(COLS_PRODUCTO));
    }
    if (prodErr) throw prodErr;

    // Los kits salen de la lista de compra; sus ventas se reparten en las piezas (abrirKits).
    const piezasPorKit = await todasLasPiezas(supabase);
    const productos = (productosTodos || []).filter(p => !piezasPorKit[p.sku]?.length);

    // Todo el módulo razona en UNIDADES DE DEPÓSITO: el stock, las llegadas de
    // importaciones y la cantidad sugerida a pedir están en cajas sueltas. Las
    // ventas y devoluciones, en cambio, vienen en unidades vendidas (un par de
    // sliders es cantidad 1), así que se convierten acá para que la velocidad
    // de demanda quede en la misma moneda que el stock.
    const upvBySku = {};
    for (const p of (productos || [])) upvBySku[p.sku] = p.unidades_por_venta || 1;
    const aUnidades = (sku, cantidad) => (Number(cantidad) || 0) * (upvBySku[sku] || 1);

    // ── 2. Sales velocity: last DEMAND_WINDOW_DAYS, ALL channels, exclude cancelled ──
    const today = new Date();
    const since = new Date(today);
    since.setDate(since.getDate() - DEMAND_WINDOW_DAYS);
    const sinceStr = since.toISOString().slice(0, 10);

    // Paginado: pasando las 1000 ventas, Supabase cortaba en silencio y la velocidad salía de
    // una parte del historial.
    const { data: ventas, error: ventasErr } = await todasLasFilas(() => supabase
      .from('ventas')
      .select('id, sku, cantidad, fecha, total, comision, canal')
      .neq('estado', 'cancelada')
      .order('fecha', { ascending: true })
      .order('id', { ascending: true }));
    if (ventasErr) throw ventasErr;

    // Aggregate units sold, track first/last sale date, and keep a per-day
    // series per SKU. soldBySku/first/lastDateBySku quedan acotados a la ventana
    // de demanda (definen la demanda "reciente"); dailyQtyBySku guarda TODO el
    // historial porque lo usa findStockoutPeriods, que necesita ver ventas
    // anteriores al corte de la ventana para confirmar tramos en 0 (ver
    // comentario en esa función).
    const soldBySku      = {};
    const firstDateBySku = {};
    const lastDateBySku  = {};
    const dailyQtyBySku  = {}; // sku -> { 'YYYY-MM-DD': qty }, historial completo

    for (const v of abrirKits(ventas, piezasPorKit)) {
      const uds = v.uds ?? aUnidades(v.sku, v.cantidad);
      if (!dailyQtyBySku[v.sku]) dailyQtyBySku[v.sku] = {};
      dailyQtyBySku[v.sku][v.fecha] = (dailyQtyBySku[v.sku][v.fecha] || 0) + uds;

      if (v.fecha < sinceStr) continue; // fuera de la ventana de demanda: solo aporta a la reconstrucción
      soldBySku[v.sku] = (soldBySku[v.sku] || 0) + uds;
      if (!firstDateBySku[v.sku] || v.fecha < firstDateBySku[v.sku]) firstDateBySku[v.sku] = v.fecha;
      if (!lastDateBySku[v.sku]  || v.fecha > lastDateBySku[v.sku])  lastDateBySku[v.sku]  = v.fecha;
    }

    // ── 2b. Devoluciones confirmadas: se descuentan de la demanda (solo las de
    // la ventana de demanda — si no, una venta devuelta sigue "contando" como
    // demanda real y sobreestima la velocidad). returnsBySku guarda todo el
    // historial, igual que dailyQtyBySku, para la reconstrucción de stock.
    // select('*'): sku_recibido puede no existir todavía si la migración no corrió.
    const { data: devoluciones, error: devErr } = await supabase
      .from('devoluciones')
      .select('*')
      .eq('estado', 'recibida');
    if (devErr) throw devErr;

    const returnedBySku = {};
    const returnsBySku  = {}; // sku -> [{ fecha, qty }], historial completo
    for (const d of abrirKits(devoluciones, piezasPorKit)) {
      // Producto equivocado: la venta de A es demanda real (se le reenvió el correcto) y B
      // bajó al registrar y volvió al recibir, así que no mueve ni la demanda ni el stock.
      if (d.sku_recibido) continue;
      const fecha = (d.recibida_at || '').slice(0, 10);
      if (!fecha || !d.cantidad) continue;
      const uds = d.uds ?? aUnidades(d.sku, d.cantidad);
      if (fecha >= sinceStr) returnedBySku[d.sku] = (returnedBySku[d.sku] || 0) + uds;
      if (!returnsBySku[d.sku]) returnsBySku[d.sku] = [];
      returnsBySku[d.sku].push({ fecha, qty: uds });
    }

    // ── 2c. Llegadas de importaciones ya recibidas, para reconstruir el stock
    // histórico día a día (ver findStockoutPeriods) y detectar tramos donde el
    // producto estuvo genuinamente sin stock, en vez de sin demanda.
    const { data: arrivedImports, error: arrErr } = await supabase
      .from('importaciones')
      .select('llegada, estado, items')
      .in('estado', ['recibido', 'arrived', 'en_deposito'])
      .not('llegada', 'is', null);
    if (arrErr) throw arrErr;

    const arrivalsBySku = {}; // sku -> [{ fecha, qty }]
    for (const imp of (arrivedImports || [])) {
      for (const item of (imp.items || [])) {
        if (!item.sku || !item.qty) continue;
        if (!arrivalsBySku[item.sku]) arrivalsBySku[item.sku] = [];
        arrivalsBySku[item.sku].push({ fecha: imp.llegada, qty: item.qty });
      }
    }

    // ── 3. Importaciones activas (ordered / in_transit) ──────────────────────
    const { data: importaciones } = await supabase
      .from('importaciones')
      .select('id, llegada, estado, items')
      .not('estado', 'in', '("arrived","cancelled","llegada","recibido","en_deposito")');

    // Build map: sku → [{ qty, llegada, estado, import_id }]
    const transitBySku = {};
    for (const imp of (importaciones || [])) {
      for (const item of (imp.items || [])) {
        if (!item.sku) continue;
        if (!transitBySku[item.sku]) transitBySku[item.sku] = [];
        transitBySku[item.sku].push({
          qty:       item.qty || 0,
          llegada:   imp.llegada || null,
          estado:    imp.estado,
          import_id: imp.id,
        });
      }
    }

    // ── 4. Importaciones terminales: lead time real ───────────────────────────
    const { data: terminalImports, error: termErr } = await supabase
      .from('importaciones')
      .select('fecha, llegada')
      .in('estado', ['recibido', 'arrived', 'en_deposito'])
      .not('fecha', 'is', null)
      .not('llegada', 'is', null)
      .order('fecha', { ascending: false });
    if (termErr) throw termErr;

    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().slice(0, 10);

    const last10  = (terminalImports || []).slice(0, 10); // ya viene ordenado desc por fecha
    const last6mo = (terminalImports || []).filter(i => i.fecha >= sixMonthsAgoStr);
    const sampleSet = last10.length >= last6mo.length ? last10 : last6mo;

    const leadTimes = sampleSet
      .map(i => Math.round((new Date(i.llegada) - new Date(i.fecha)) / MS_PER_DAY))
      .filter(d => d > 0); // descarta filas con datos corruptos (llegada <= fecha)

    // Mediana en vez de promedio: con muestras chicas (n=3 típico acá), un solo
    // envío demorado por aduana desplaza la media mucho más de lo razonable.
    const leadTimePromedio = leadTimes.length >= 3
      ? Math.round(median(leadTimes))
      : FALLBACK_LEAD_DAYS;
    const leadTimeStdevRaw = leadTimes.length >= 2 ? stdev(leadTimes) : null;
    const sigmaLT = leadTimeStdevRaw !== null ? leadTimeStdevRaw : leadTimePromedio * DEFAULT_LT_CV;

    // ── 4b. Economía: lo que deja cada producto (para la clase de compra) ──────
    // Solo ventas propias del SKU (un kit tiene su propio precio, no cuenta para la pieza).
    const econSince = new Date(today);
    econSince.setDate(econSince.getDate() - ECON_WINDOW_DAYS);
    const econSinceStr = econSince.toISOString().slice(0, 10);
    const adsSince = new Date(today);
    adsSince.setDate(adsSince.getDate() - ADS_WINDOW_DAYS);
    const adsSinceStr = adsSince.toISOString().slice(0, 10);

    // Publicidad. Las dos tablas pueden no existir (sin Mercado Ads conectado): sin dato, el
    // porcentaje por defecto.
    const [anunciosResp, diarioResp] = await Promise.all([
      todasLasFilas(() => supabase.from('meli_ads_anuncios')
        .select('sku, fecha, spend')
        .gte('fecha', adsSinceStr)
        .gt('spend', 0)
        .not('sku', 'is', null)
        .order('fecha', { ascending: true })
        .order('ad_group_id', { ascending: true })),
      supabase.from('meli_ads_diario').select('fecha, spend').gte('fecha', adsSinceStr),
    ]);
    const anuncios = anunciosResp.error ? [] : (anunciosResp.data || []);
    const diario = diarioResp.error ? [] : (diarioResp.data || []);
    // Cada snapshot puede arrancar después del corte (meli_ads_anuncios se empezó a guardar
    // el 8/10/2026; meli_ads_diario mucho antes): la facturación con la que se compara cada
    // gasto tiene que ser la del mismo tramo que ESE gasto.
    const primeraFecha = filas => filas.map(r => r.fecha).filter(Boolean).sort()[0] || adsSinceStr;
    const adsDesdeSku    = primeraFecha(anuncios);
    const adsDesdeCuenta = primeraFecha(diario);

    const adsIvaBySku = {};
    for (const r of anuncios) {
      const k = normSku(r.sku);
      if (!k) continue;
      adsIvaBySku[k] = (adsIvaBySku[k] || 0) + (Number(r.spend) || 0) * FACTOR_IVA_ADS;
    }
    const factMeliAdsBySku = {};
    let factMeliAds = 0;
    const econBySku = {};    // sku -> { uds, fact, factMeli, neto } de los últimos ECON_WINDOW_DAYS
    const econVentana = {};  // ídem, toda la ventana de demanda (respaldo)
    for (const v of ventas || []) {
      const k = normSku(v.sku);
      const total = Number(v.total) || 0;
      const esMeli = v.canal === 'meli';
      if (esMeli && v.fecha >= adsDesdeSku) factMeliAdsBySku[k] = (factMeliAdsBySku[k] || 0) + total;
      if (esMeli && v.fecha >= adsDesdeCuenta) factMeliAds += total;
      if (v.fecha < sinceStr) continue;
      const sumar = (mapa) => {
        const e = mapa[k] || (mapa[k] = { uds: 0, fact: 0, factMeli: 0, neto: 0 });
        e.uds += Number(v.cantidad) || 0;
        e.fact += total;
        if (esMeli) e.factMeli += total;
        e.neto += total - (Number(v.comision) || 0);
      };
      sumar(econVentana);
      if (v.fecha >= econSinceStr) sumar(econBySku);
    }
    const adsIvaTotal = diario.reduce((s, r) => s + (Number(r.spend) || 0) * FACTOR_IVA_ADS, 0);
    const adsPctCuenta = adsIvaTotal > 0 && factMeliAds > 0 ? Math.min(1, adsIvaTotal / factMeliAds) : ADS_PCT_DEFAULT;

    // ── 5. Calculate restock metrics per product ──────────────────────────────
    const todayStr  = today.toISOString().slice(0, 10);
    const LEAD_DAYS = leadTimePromedio;

    const results = [];

    for (const p of productos) {
      const totalSold = Math.max(0, (soldBySku[p.sku] || 0) - (returnedBySku[p.sku] || 0));
      const stock     = p.stock_dep || 0;
      const alertaMin = p.alerta_min || 0;

      // Ventana de venta activa: por defecto, TODO el período en que el
      // producto pudo haber estado a la venta dentro de la ventana de demanda —
      // desde que se publicó (o desde que lo cargamos en el sistema, si no
      // tenemos fecha real) hasta hoy (o hasta la última venta, si ya está sin
      // stock). No arranca en la primera venta: un producto puede llevar
      // semanas o meses disponible sin venderse — eso es demanda baja real, no
      // debería excluirse del cálculo solo porque "todavía no vendió nada".
      //
      // De esa ventana se restan los tramos donde el stock reconstruido
      // (ventas + llegadas + devoluciones, ver findStockoutPeriods) da EXACTO
      // 0 — esos sí son días en que la venta era imposible, no que faltó
      // demanda, y diluirían la velocidad real si se contaran igual.
      let activeDays = DEMAND_WINDOW_DAYS;
      let spanDays   = 0;
      let stockoutPeriods = [];
      let diasSinStock    = 0;
      let windowStart = null;
      let windowEnd   = null;
      if (totalSold > 0) {
        const publicacionRef = p.fecha_publicacion || (p.created_at ? p.created_at.slice(0, 10) : null);
        windowStart = (publicacionRef && publicacionRef > sinceStr) ? publicacionRef : sinceStr;
        windowEnd   = stock > 0 ? todayStr : lastDateBySku[p.sku];

        const rawSpanDays = Math.max(1, Math.round(
          (new Date(windowEnd) - new Date(windowStart)) / MS_PER_DAY
        ) + 1);

        const tramos = vel => findStockoutPeriods(
          dailyQtyBySku[p.sku] || {}, arrivalsBySku[p.sku] || [], returnsBySku[p.sku] || [],
          stock, windowStart, windowEnd, vel
        );
        const sumaDias = pers => pers.reduce((a, per) => a + per.dias, 0);
        // Primera pasada: solo los tramos con stock 0 exacto. Con esa velocidad, segunda pasada
        // que también saca los tramos largos con 1–2 unidades residuales (ver arriba).
        stockoutPeriods = tramos(0);
        const velPrimera = totalSold / Math.max(MIN_DAYS_LOW_SAMPLE, rawSpanDays - sumaDias(stockoutPeriods));
        const conResiduales = tramos(velPrimera);
        if (sumaDias(conResiduales) > sumaDias(stockoutPeriods)) stockoutPeriods = conResiduales;
        diasSinStock = sumaDias(stockoutPeriods);

        spanDays   = Math.max(1, rawSpanDays - diasSinStock);
        activeDays = spanDays;

        // Con una muestra muy chica, ni siquiera esta ventana alcanza si el
        // producto es nuevo de verdad (publicado y vendido casi el mismo día):
        // una sola venta el día 1 no es una tasa diaria confiable.
        //
        // El piso mira las DOS caras de la muestra, no sólo las unidades: pocos
        // días observados extrapolan igual de mal aunque las unidades no sean
        // pocas. EXT-ESP-10F-10F-001 vendió 4 uds el día que se publicó y, con
        // sólo 3 días de ventana, daba 1.33/día → 144 unidades sugeridas para
        // cubrir el lead time. Con el piso queda en 0.29/día, que sigue marcando
        // que hay que reponer pero con una cantidad que se puede mirar sin susto.
        if (totalSold <= 2 || spanDays < MIN_DAYS_LOW_SAMPLE) {
          activeDays = Math.max(activeDays, MIN_DAYS_LOW_SAMPLE);
        }
      }

      const dailyVelocity = totalSold > 0 ? totalSold / activeDays : 0;

      // Desvío estándar de la demanda diaria real, medido sobre la ventana
      // observada de ventas (primera → última venta). Con pocos días de datos
      // reales (< MIN_SPAN_FOR_STDEV) no hay muestra suficiente para confiar en
      // un desvío empírico, así que se asume una variabilidad conservadora
      // (DEFAULT_DEMAND_CV) en vez de stock de seguridad cero.
      let sigmaDemand = dailyVelocity * DEFAULT_DEMAND_CV;
      if (totalSold > 0 && spanDays >= MIN_SPAN_FOR_STDEV) {
        const dayMap = dailyQtyBySku[p.sku] || {};
        const series = [];
        const d = new Date(windowStart);
        const end = new Date(windowEnd);
        while (d <= end) {
          const key = d.toISOString().slice(0, 10);
          const enHuecoConfirmado = stockoutPeriods.some(per => key >= per.desde && key <= per.hasta);
          if (!enHuecoConfirmado) series.push(dayMap[key] || 0);
          d.setDate(d.getDate() + 1);
        }
        const empirical = stdev(series);
        if (empirical !== null) sigmaDemand = empirical;
      }

      // Punto de pedido = demanda esperada durante el lead time + stock de
      // seguridad (variabilidad de demanda Y de lead time combinadas).
      const safetyStockUnits = dailyVelocity > 0
        ? SERVICE_Z * Math.sqrt(LEAD_DAYS * sigmaDemand ** 2 + dailyVelocity ** 2 * sigmaLT ** 2)
        : 0;
      const reorderPointUnits = dailyVelocity * LEAD_DAYS + safetyStockUnits;

      // Clase de compra: cuánto deja este producto, en total y por cada peso de stock.
      const upvP   = upvBySku[p.sku] || 1;
      const costo  = Number(p.costo) || 0;
      const kSku   = normSku(p.sku);
      const econ   = econBySku[kSku] || econVentana[kSku] || null;
      const econUdsDep = econ ? econ.uds * upvP : 0;
      const adsPropio  = factMeliAdsBySku[kSku] > 0 && adsIvaBySku[kSku] !== undefined
        ? Math.min(1, adsIvaBySku[kSku] / factMeliAdsBySku[kSku])
        : null;
      // Sin gasto propio registrado: si el snapshot existe y el producto vendió en MELI en ese
      // tramo sin aparecer, puede no estar anunciado o no estar vinculado a su SKU; se toma el
      // promedio de la cuenta (conservador) y se avisa que es estimado.
      const adsPct = adsPropio !== null ? adsPropio : (econ && econ.factMeli > 0 ? adsPctCuenta : 0);
      const adsEstimado = adsPropio === null && !!econ && econ.factMeli > 0;
      const contribSinAds = econ ? econ.neto - costo * econUdsDep : 0;
      const contribConAds = econ ? contribSinAds - adsPct * econ.factMeli : 0;
      const publicacionDesde = p.fecha_publicacion || (p.created_at ? p.created_at.slice(0, 10) : null);
      const clasif = C.clasificar({
        vendidas:           totalSold,
        dias_activos:       totalSold > 0 ? activeDays : 0,
        // Días entre fechas (no desde la hora actual): si no, a la tarde un "68 días" pasaba a 69.
        dias_publicado:     publicacionDesde ? Math.max(0, Math.round((new Date(todayStr) - new Date(publicacionDesde)) / MS_PER_DAY)) : null,
        ventana_dias:       DEMAND_WINDOW_DAYS,
        lead_dias:          LEAD_DAYS,
        stock,
        costo,
        ventas_mes:         dailyVelocity * 30,
        econ_uds:           econUdsDep,
        contrib_ud:         econUdsDep > 0 ? contribConAds / econUdsDep : 0,
        contrib_ud_sin_ads: econUdsDep > 0 ? contribSinAds / econUdsDep : 0,
        ads_pct:            adsPct,
        ads_estimado:       adsEstimado,
        en_camino:          (transitBySku[p.sku] || []).reduce((a, t) => a + (t.qty || 0), 0),
        dias_desde_llegada: (() => {
          const ultima = (arrivalsBySku[p.sku] || []).map(a => a.fecha).filter(Boolean).sort().pop();
          return ultima ? Math.max(0, Math.round((new Date(todayStr) - new Date(ultima)) / MS_PER_DAY)) : null;
        })(),
      });
      const objetivoClase = C.objetivoUnidades(clasif.clase, {
        velocidad: dailyVelocity, leadDias: LEAD_DAYS, puntoPedido: reorderPointUnits,
      });
      const noComprar = clasif.clase === 'descatalogar';

      // Expresado en días de cobertura equivalente, para mantener las columnas
      // existentes de "ventana" con el mismo significado que antes.
      const coberturaObjetivoDias = dailyVelocity > 0 ? objetivoClase / dailyVelocity : LEAD_DAYS;

      let daysCoverage  = null;
      let restockDate   = null;
      let stockoutDate  = null;

      if (dailyVelocity > 0) {
        daysCoverage = stock / dailyVelocity;

        restockDate  = new Date(today.getTime() + (daysCoverage - LEAD_DAYS) * MS_PER_DAY)
          .toISOString().slice(0, 10);
        stockoutDate = new Date(today.getTime() + daysCoverage * MS_PER_DAY)
          .toISOString().slice(0, 10);
      }

      const transito      = transitBySku[p.sku] || [];
      const already_ordered = transito.length > 0;
      const qty_en_transito = transito.reduce((a, t) => a + t.qty, 0);
      // Earliest expected arrival among active orders
      const proxima_llegada = transito
        .map(t => t.llegada)
        .filter(Boolean)
        .sort()[0] || null;

      const coberturaProyectadaDias = dailyVelocity > 0
        ? (stock + qty_en_transito) / dailyVelocity
        : null;

      // Simula si el stock físico se agota antes de que llegue el próximo envío,
      // en vez de sumar todo el tránsito como si estuviera disponible hoy.
      const { tieneQuiebre, gapCierraFecha, agotaFecha } = computeStockoutGap(
        stock, dailyVelocity, transito, LEAD_DAYS, today
      );

      // Un "descatalogar" no se compra aunque tenga piso manual: el piso es de cuando se vendía.
      const targetUnits   = noComprar ? 0 : Math.max(objetivoClase, alertaMin);
      const crudaSugerida = noComprar ? 0 : dailyVelocity > 0
        ? Math.max(0, Math.ceil(targetUnits - stock - qty_en_transito))
        : Math.max(0, Math.ceil(alertaMin - stock - qty_en_transito));
      // Los productos de a par se piden de a par: media unidad sobrante no se
      // puede vender, así que la sugerencia se redondea al pack completo.
      const upv = upvBySku[p.sku] || 1;
      const cantidadSugerida = upv > 1 ? Math.ceil(crudaSugerida / upv) * upv : crudaSugerida;
      // Math.ceil (no Math.round): mejor sugerir de más por redondeo que quedar
      // corto. No modelamos MOQ por proveedor porque hoy no aplica (pedidos chicos).

      let restockStatus;
      if (dailyVelocity === 0) {
        // Sin una sola venta en la ventana de demanda no hay nada que proyectar:
        // ni fecha de quiebre ni cantidad a pedir. Se etiqueta aparte ('sin_ventas')
        // en vez de mezclarlo con 'proximo', que significa "vende y hay que pedir
        // pronto". Igual se devuelve: el producto existe, tiene stock y plata
        // inmovilizada, y el usuario quiere verlo en el listado completo.
        restockStatus = already_ordered ? 'cubierto' : 'sin_ventas';
      } else if (already_ordered && tieneQuiebre) {
        // Hay pedido en camino, pero el stock actual no llega a esa fecha:
        // esto es lo que antes se escondía como "cubierto".
        restockStatus = 'quiebre_confirmado';
      } else if (coberturaProyectadaDias >= coberturaObjetivoDias) {
        restockStatus = 'cubierto';
      } else if (already_ordered) {
        restockStatus = 'insuficiente';
      } else {
        const critical = stockoutDate <= todayStr || restockDate <= todayStr;
        restockStatus = critical ? 'ordenar_ya' : 'proximo';
      }

      // Piso manual: alerta_min refleja criterio del negocio que el modelo de
      // demanda no tiene (p. ej. "de esto siempre quiero tener al menos 5").
      // Si el stock físico ya está por debajo, se escala el status — pero nunca
      // se baja la urgencia de un status ya crítico.
      if (alertaMin > 0 && stock < alertaMin && !noComprar &&
          (restockStatus === 'cubierto' || restockStatus === 'proximo' || restockStatus === 'sin_ventas')) {
        restockStatus = already_ordered ? 'insuficiente' : 'ordenar_ya';
      }
      // Descatalogar le gana a todo: lo que hay se liquida y no se vuelve a pedir.
      if (noComprar) restockStatus = 'no_comprar';

      results.push({
        sku:                        p.sku,
        nombre:                     p.nombre,
        grupo:                      p.grupo || '',
        subgrupo:                   p.subgrupo || '',
        proveedor_id:               p.proveedor_id || null,
        stock:                      stock,
        unidades_por_venta:         upvBySku[p.sku] || 1,
        alerta_min:                 alertaMin,
        total_sold:                 totalSold,
        active_days:                totalSold > 0 ? activeDays : null,
        dias_sin_stock_excluidos:   diasSinStock,
        periodos_sin_stock:         stockoutPeriods,
        daily_velocity:             Math.round(dailyVelocity * 100) / 100,
        days_coverage:              daysCoverage !== null ? Math.round(daysCoverage) : null,
        restock_date:               restockDate,
        stockout_date:              stockoutDate,
        cobertura_proyectada_dias:  coberturaProyectadaDias !== null ? Math.round(coberturaProyectadaDias) : null,
        cobertura_objetivo_dias:    Math.round(coberturaObjetivoDias),
        safety_stock_uds:           Math.round(safetyStockUnits),
        punto_pedido_uds:           Math.round(reorderPointUnits),
        objetivo_uds:               Math.round(targetUnits), // meta de la clase: stock + en camino
        cantidad_sugerida:          cantidadSugerida,
        clase:                      clasif.clase,
        clase_motivo:               clasif.motivo,
        motivo_sugerido:            clasif.motivo_sugerido,  // si se descataloga (api/_discontinuado.js)
        contrib_mes:                clasif.contrib_mes,      // lo que deja por mes después de Ads
        retorno_100:                clasif.retorno,          // lo que deja por cada $100 de costo
        retorno_100_sin_ads:        clasif.retorno_sin_ads,
        ads_pct:                    Math.round(adsPct * 100),
        ads_estimado:               adsEstimado,
        costo,
        valor_stock:                Math.round(costo * stock),
        compra_mes:                 Math.round(costo * dailyVelocity * 30), // lo que hay que reponer por mes
        restock_status:             restockStatus,
        gap_cierra_fecha:           restockStatus === 'quiebre_confirmado' ? gapCierraFecha : null,
        agota_con_transito:         agotaFecha,     // fin del stock actual + todo lo que viene en camino
        already_ordered,
        en_transito:                transito,       // full detail array
        qty_en_transito,
        proxima_llegada,
        today:                      todayStr,
      });
    }

    // Sort: most urgent first
    // 'sin_ventas' va último: son los que no tienen señal de demanda, así que no
    // compiten por atención con los que sí hay que reponer.
    // Dentro del mismo estado, los ⭐ "nunca sin stock" van primero: son la primera plata de
    // cada compra.
    const STATUS_RANK = { quiebre_confirmado: 0, ordenar_ya: 1, insuficiente: 2, proximo: 3, cubierto: 4, sin_ventas: 5, no_comprar: 6 };
    const CLASE_RANK  = { nunca: 0, siempre: 1, nuevo: 2, sin_datos: 2, poco: 3, descatalogar: 4 };
    results.sort((a, b) => {
      const rankDiff = STATUS_RANK[a.restock_status] - STATUS_RANK[b.restock_status];
      if (rankDiff !== 0) return rankDiff;
      const claseDiff = (CLASE_RANK[a.clase] ?? 9) - (CLASE_RANK[b.clase] ?? 9);
      if (claseDiff !== 0) return claseDiff;
      if (!a.restock_date) return 1;
      if (!b.restock_date) return -1;
      return a.restock_date < b.restock_date ? -1 : 1;
    });

    return res.json({
      lead_time_promedio: leadTimePromedio,
      lead_time_muestra:  leadTimes.length,
      lead_time_stdev:    leadTimeStdevRaw !== null ? Math.round(leadTimeStdevRaw) : null,
      lead_time_min:      leadTimes.length ? Math.min(...leadTimes) : null,
      lead_time_max:      leadTimes.length ? Math.max(...leadTimes) : null,
      lead_time_metodo:   leadTimes.length >= 3 ? 'mediana' : 'valor por defecto',
      clases:             C.resumenClases(results),
      clases_colchon_dias: C.COLCHON_DIAS,
      ads_pct_cuenta:     Math.round(adsPctCuenta * 100),
      productos:          results,
    });
  } catch (err) {
    console.error('Error en /api/restock:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Para los tests (tests/kits.test.js).
module.exports.abrirKits = abrirKits;
