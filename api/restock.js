// api/restock.js
// GET /api/restock
//
// Returns { lead_time_promedio, lead_time_muestra, lead_time_stdev, lead_time_min,
//           lead_time_max, lead_time_metodo, productos } where each product has:
//   - daily_velocity           = units sold (net of confirmed returns) / active selling days
//   - days_coverage            = current stock / daily_velocity
//   - restock_date             = today + days_coverage − lead_time_promedio (last day to order before stockout)
//   - stockout_date            = today + days_coverage
//   - cobertura_proyectada_dias = (stock + qty_en_transito) / daily_velocity  (total pipeline supply, ignores timing)
//   - punto_pedido_uds         = demanda esperada durante el lead time + stock de seguridad estadístico
//   - safety_stock_uds         = colchón por variabilidad de demanda y de lead time (fórmula de King)
//   - cantidad_sugerida        = units still needed to reach punto_pedido_uds (or alerta_min, lo que sea mayor)
//   - restock_status           = 'quiebre_confirmado' | 'ordenar_ya' | 'insuficiente' | 'proximo' | 'cubierto'
//   - already_ordered          = true if the SKU appears in a non-arrived import (kept for compat)
//   - gap_cierra_fecha         = si hay quiebre_confirmado, fecha en la que el próximo envío lo cierra
//
// CRITICAL: sales velocity aggregates ALL channels (meli + mostrador + shopify).
// No channel filter is applied anywhere in this file.

const { getSupabase } = require('./_supabase');

const FALLBACK_LEAD_DAYS = 85;
const MS_PER_DAY         = 86400 * 1000;

// ── Modelo de stock de seguridad (fórmula de King: demanda y lead time inciertos) ──
// safety_stock = Z · √( LEAD_DAYS · σ_demanda² + demanda_diaria² · σ_leadtime² )
// Reemplaza el margen fijo (antes: lead_time × 1.15 igual para todos los SKUs) por
// un colchón que crece con la variabilidad real de cada producto y del lead time,
// en vez de tratar a un producto de venta pareja igual que uno errático.
const SERVICE_Z          = 1.28; // ~90% de nivel de servicio (ajustable según tolerancia a quiebres vs. capital inmovilizado)
const DEFAULT_DEMAND_CV  = 0.75; // coef. de variación asumido cuando no hay suficientes días de venta para medirlo empíricamente
const DEFAULT_LT_CV      = 0.30; // ídem para lead time, cuando hay <2 importaciones terminales con datos
const MIN_SPAN_FOR_STDEV = 5;    // días mínimos de ventana real de ventas para confiar en el desvío empírico de demanda
const MIN_DAYS_LOW_SAMPLE = 14;  // piso de días activos cuando hay 1-2 ventas y no alcanza con fecha de publicación

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
function computeStockoutGap(stock, dailyVelocity, transito, leadTimePromedio, today) {
  if (dailyVelocity <= 0 || !transito.length) return { tieneQuiebre: false, gapCierraFecha: null };

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

  return { tieneQuiebre, gapCierraFecha };
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
    const { data: productos, error: prodErr } = await supabase
      .from('productos')
      .select('sku, nombre, categoria, stock_dep, tipo, fecha_publicacion, alerta_min, created_at')
      .neq('tipo', 'usado')
      .or('discontinuado.is.null,discontinuado.eq.false');
    if (prodErr) throw prodErr;

    // ── 2. Sales velocity: last 90 days, ALL channels, exclude cancelled ─────
    // 90-day window instead of 30 so products that ran out of stock 30-90 days
    // ago still have sales data and show a real velocity instead of "Sin ventas".
    const today = new Date();
    const since = new Date(today);
    since.setDate(since.getDate() - 90);
    const sinceStr = since.toISOString().slice(0, 10);

    const { data: ventas, error: ventasErr } = await supabase
      .from('ventas')
      .select('sku, cantidad, fecha')
      .gte('fecha', sinceStr)
      .neq('estado', 'cancelada');
    if (ventasErr) throw ventasErr;

    // Aggregate units sold, track first/last sale date, and keep a per-day
    // series per SKU (used below to measure real demand variability).
    const soldBySku      = {};
    const firstDateBySku = {};
    const lastDateBySku  = {};
    const dailyQtyBySku  = {}; // sku -> { 'YYYY-MM-DD': qty }

    for (const v of ventas) {
      soldBySku[v.sku] = (soldBySku[v.sku] || 0) + v.cantidad;
      if (!firstDateBySku[v.sku] || v.fecha < firstDateBySku[v.sku]) firstDateBySku[v.sku] = v.fecha;
      if (!lastDateBySku[v.sku]  || v.fecha > lastDateBySku[v.sku])  lastDateBySku[v.sku]  = v.fecha;
      if (!dailyQtyBySku[v.sku]) dailyQtyBySku[v.sku] = {};
      dailyQtyBySku[v.sku][v.fecha] = (dailyQtyBySku[v.sku][v.fecha] || 0) + v.cantidad;
    }

    // ── 2b. Devoluciones confirmadas en la misma ventana: se descuentan de la
    // demanda. Si no, una venta devuelta sigue "contando" como demanda real y
    // sobreestima la velocidad (y por lo tanto la cantidad sugerida a pedir).
    const { data: devoluciones, error: devErr } = await supabase
      .from('devoluciones')
      .select('sku, cantidad, recibida_at')
      .eq('estado', 'recibida')
      .gte('recibida_at', sinceStr);
    if (devErr) throw devErr;

    const returnedBySku = {};
    for (const d of (devoluciones || [])) {
      returnedBySku[d.sku] = (returnedBySku[d.sku] || 0) + (d.cantidad || 0);
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

    // ── 5. Calculate restock metrics per product ──────────────────────────────
    const todayStr  = today.toISOString().slice(0, 10);
    const LEAD_DAYS = leadTimePromedio;

    const results = [];

    for (const p of productos) {
      const totalSold = Math.max(0, (soldBySku[p.sku] || 0) - (returnedBySku[p.sku] || 0));
      const stock     = p.stock_dep || 0;
      const alertaMin = p.alerta_min || 0;

      // Active selling period: first sale → last sale within the 90-day window.
      // Velocity = units sold ÷ active days (not total window days).
      // This way stockout days — when nothing sold because there was no stock —
      // don't drag the daily rate down.
      // With very few sales (e.g. a single sale), first==last collapses this to
      // 1 day, which wildly overstates velocity for a product that's simply been
      // listed a long time with low demand. Floor it with days since the listing
      // was first published (capped at the 90-day sales window, since that's all
      // the sales data we have) whenever that's known and larger.
      //
      // That floor should stop at the last sale, not run to today, once the
      // product is out of stock: with stock=0 there's no way it could have sold
      // anything since then, so counting those extra no-stock days as "active"
      // would dilute the rate and understate real demand. While stock>0 it's
      // still a live selling opportunity, so today is the right reference point.
      let activeDays = 90;
      let spanDays   = 0;
      if (totalSold > 0) {
        const diffMs = new Date(lastDateBySku[p.sku]) - new Date(firstDateBySku[p.sku]);
        spanDays     = Math.max(1, Math.round(diffMs / 86400000) + 1);
        activeDays   = spanDays;

        // fecha_publicacion es la fecha real de alta en MELI/Shopify; cuando no
        // la tenemos cargada (5 de 48 productos activos, hoy), created_at (alta
        // en nuestro sistema) es el mejor proxy disponible — sin este fallback
        // el piso de abajo nunca se aplicaba y esos SKUs quedaban con el bug que
        // esto arregla: una sola venta = 1 día activo = velocidad de 1/día.
        const publicacionRef = p.fecha_publicacion || (p.created_at ? p.created_at.slice(0, 10) : null);
        if (publicacionRef) {
          const referenceDate = stock > 0 ? today : new Date(lastDateBySku[p.sku]);
          const daysSincePublicacion = Math.round((referenceDate - new Date(publicacionRef)) / 86400000) + 1;
          activeDays = Math.max(activeDays, Math.min(90, daysSincePublicacion));
        }

        // Con 1-2 ventas nada más, ni siquiera ese piso alcanza si el producto
        // es nuevo de verdad (publicado y vendido casi el mismo día): una sola
        // venta el día 1 no es una tasa diaria confiable, es un dato suelto.
        if (totalSold <= 2) activeDays = Math.max(activeDays, MIN_DAYS_LOW_SAMPLE);
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
        const d = new Date(firstDateBySku[p.sku]);
        const end = new Date(lastDateBySku[p.sku]);
        while (d <= end) {
          const key = d.toISOString().slice(0, 10);
          series.push(dayMap[key] || 0);
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
      // Expresado en días de cobertura equivalente, para mantener las columnas
      // existentes de "ventana" con el mismo significado que antes.
      const coberturaObjetivoDias = dailyVelocity > 0 ? reorderPointUnits / dailyVelocity : LEAD_DAYS;

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

      // Only include products that have had sales activity OR are at zero stock
      if (dailyVelocity === 0 && stock > 0 && stock >= alertaMin) continue;

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
      const { tieneQuiebre, gapCierraFecha } = computeStockoutGap(
        stock, dailyVelocity, transito, LEAD_DAYS, today
      );

      const targetUnits   = Math.max(reorderPointUnits, alertaMin);
      const cantidadSugerida = dailyVelocity > 0
        ? Math.max(0, Math.ceil(targetUnits - stock - qty_en_transito))
        : Math.max(0, Math.ceil(alertaMin - stock - qty_en_transito));
      // Math.ceil (no Math.round): mejor sugerir de más por redondeo que quedar
      // corto. No modelamos MOQ por proveedor porque hoy no aplica (pedidos chicos).

      let restockStatus;
      if (dailyVelocity === 0) {
        restockStatus = already_ordered ? 'cubierto' : 'proximo';
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
      if (alertaMin > 0 && stock < alertaMin && (restockStatus === 'cubierto' || restockStatus === 'proximo')) {
        restockStatus = already_ordered ? 'insuficiente' : 'ordenar_ya';
      }

      results.push({
        sku:                        p.sku,
        nombre:                     p.nombre,
        categoria:                  p.categoria || '',
        stock:                      stock,
        alerta_min:                 alertaMin,
        total_sold:                 totalSold,
        active_days:                totalSold > 0 ? activeDays : null,
        daily_velocity:             Math.round(dailyVelocity * 100) / 100,
        days_coverage:              daysCoverage !== null ? Math.round(daysCoverage) : null,
        restock_date:               restockDate,
        stockout_date:              stockoutDate,
        cobertura_proyectada_dias:  coberturaProyectadaDias !== null ? Math.round(coberturaProyectadaDias) : null,
        cobertura_objetivo_dias:    Math.round(coberturaObjetivoDias),
        safety_stock_uds:           Math.round(safetyStockUnits),
        punto_pedido_uds:           Math.round(reorderPointUnits),
        cantidad_sugerida:          cantidadSugerida,
        restock_status:             restockStatus,
        gap_cierra_fecha:           restockStatus === 'quiebre_confirmado' ? gapCierraFecha : null,
        already_ordered,
        en_transito:                transito,       // full detail array
        qty_en_transito,
        proxima_llegada,
        today:                      todayStr,
      });
    }

    // Sort: most urgent first
    const STATUS_RANK = { quiebre_confirmado: 0, ordenar_ya: 1, insuficiente: 2, proximo: 3, cubierto: 4 };
    results.sort((a, b) => {
      const rankDiff = STATUS_RANK[a.restock_status] - STATUS_RANK[b.restock_status];
      if (rankDiff !== 0) return rankDiff;
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
      productos:          results,
    });
  } catch (err) {
    console.error('Error en /api/restock:', err);
    return res.status(500).json({ error: err.message });
  }
};
