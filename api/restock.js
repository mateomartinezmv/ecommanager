// api/restock.js
// GET /api/restock
//
// Returns { lead_time_promedio, lead_time_muestra, productos } where each product has:
//   - daily_velocity           = units sold / active selling days (first→last sale in window)
//                                 This corrects for stockouts: days with no stock don't dilute the average.
//   - days_coverage            = current stock / daily_velocity
//   - restock_date             = today + days_coverage − lead_time_promedio (last day to order before stockout)
//   - stockout_date            = today + days_coverage
//   - cobertura_proyectada_dias = (stock + qty_en_transito) / daily_velocity
//   - cantidad_sugerida        = units still needed to reach cobertura_objetivo_dias
//   - restock_status           = 'cubierto' | 'insuficiente' | 'ordenar_ya' | 'proximo'
//   - already_ordered          = true if the SKU appears in a non-arrived import (kept for compat)
//
// CRITICAL: sales velocity aggregates ALL channels (meli + mostrador + shopify).
// No channel filter is applied anywhere in this file.

const { getSupabase } = require('./_supabase');

const FALLBACK_LEAD_DAYS      = 85;
const COBERTURA_SAFETY_MARGIN = 1.15; // margen de seguridad sobre el lead time promedio
const MS_PER_DAY              = 86400 * 1000;

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
      .select('sku, nombre, categoria, stock_dep, tipo')
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

    // Aggregate units sold and track first/last sale date per SKU
    const soldBySku      = {};
    const firstDateBySku = {};
    const lastDateBySku  = {};

    for (const v of ventas) {
      soldBySku[v.sku] = (soldBySku[v.sku] || 0) + v.cantidad;
      if (!firstDateBySku[v.sku] || v.fecha < firstDateBySku[v.sku]) firstDateBySku[v.sku] = v.fecha;
      if (!lastDateBySku[v.sku]  || v.fecha > lastDateBySku[v.sku])  lastDateBySku[v.sku]  = v.fecha;
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

    const pendingSkus = new Set(Object.keys(transitBySku));

    // ── 4. Importaciones terminales: lead time real promedio ──────────────────
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

    const leadTimePromedio = leadTimes.length >= 3
      ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length)
      : FALLBACK_LEAD_DAYS;

    // ── 5. Calculate restock metrics per product ──────────────────────────────
    const todayStr  = today.toISOString().slice(0, 10);
    const LEAD_DAYS = leadTimePromedio;
    const coberturaObjetivoDias = LEAD_DAYS * COBERTURA_SAFETY_MARGIN;

    const results = [];

    for (const p of productos) {
      const totalSold = soldBySku[p.sku] || 0;
      const stock     = p.stock_dep || 0;

      // Active selling period: first sale → last sale within the 90-day window.
      // Velocity = units sold ÷ active days (not total window days).
      // This way stockout days — when nothing sold because there was no stock —
      // don't drag the daily rate down.
      let activeDays = 90;
      if (totalSold > 0) {
        const diffMs = new Date(lastDateBySku[p.sku]) - new Date(firstDateBySku[p.sku]);
        activeDays   = Math.max(1, Math.round(diffMs / 86400000) + 1);
      }

      const dailyVelocity = totalSold > 0 ? totalSold / activeDays : 0;

      let daysCoverage  = null;
      let restockDate   = null;
      let stockoutDate  = null;

      if (dailyVelocity > 0) {
        daysCoverage = stock / dailyVelocity;

        // Add fractional days to today's timestamp then convert back to ISO date
        const msPerDay   = 86400 * 1000;
        restockDate  = new Date(today.getTime() + (daysCoverage - LEAD_DAYS) * msPerDay)
          .toISOString().slice(0, 10);
        stockoutDate = new Date(today.getTime() + daysCoverage * msPerDay)
          .toISOString().slice(0, 10);
      }

      // Only include products that have had sales activity OR are at zero stock
      if (dailyVelocity === 0 && stock > 0) continue;

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

      const cantidadSugerida = dailyVelocity > 0
        ? Math.max(0, Math.round((dailyVelocity * coberturaObjetivoDias) - stock - qty_en_transito))
        : 0;

      let restockStatus;
      if (dailyVelocity === 0) {
        restockStatus = already_ordered ? 'cubierto' : 'proximo';
      } else if (coberturaProyectadaDias >= coberturaObjetivoDias) {
        restockStatus = 'cubierto';
      } else if (already_ordered) {
        restockStatus = 'insuficiente';
      } else {
        const critical = stockoutDate <= todayStr || restockDate <= todayStr;
        restockStatus = critical ? 'ordenar_ya' : 'proximo';
      }

      results.push({
        sku:                        p.sku,
        nombre:                     p.nombre,
        categoria:                  p.categoria || '',
        stock:                      stock,
        total_sold:                 totalSold,
        active_days:                totalSold > 0 ? activeDays : null,
        daily_velocity:             Math.round(dailyVelocity * 100) / 100,
        days_coverage:              daysCoverage !== null ? Math.round(daysCoverage) : null,
        restock_date:               restockDate,
        stockout_date:              stockoutDate,
        cobertura_proyectada_dias:  coberturaProyectadaDias !== null ? Math.round(coberturaProyectadaDias) : null,
        cobertura_objetivo_dias:    Math.round(coberturaObjetivoDias),
        cantidad_sugerida:          cantidadSugerida,
        restock_status:             restockStatus,
        already_ordered,
        en_transito:                transito,       // full detail array
        qty_en_transito,
        proxima_llegada,
        today:                      todayStr,
      });
    }

    // Sort: most urgent first (ordenar_ya > insuficiente > proximo > cubierto)
    const STATUS_RANK = { ordenar_ya: 0, insuficiente: 1, proximo: 2, cubierto: 3 };
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
      productos:          results,
    });
  } catch (err) {
    console.error('Error en /api/restock:', err);
    return res.status(500).json({ error: err.message });
  }
};
