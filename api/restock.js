// api/restock.js
// GET /api/restock
//
// Returns restock calendar data for every product:
//   - daily_velocity  = units sold / active selling days (first→last sale in window)
//                       This corrects for stockouts: days with no stock don't dilute the average.
//   - days_coverage   = current stock / daily_velocity
//   - restock_date    = today + days_coverage − 75  (last day to place order before stockout)
//   - stockout_date   = today + days_coverage
//   - already_ordered = true if the SKU appears in a non-arrived import
//
// CRITICAL: sales velocity aggregates ALL channels (meli + mostrador + shopify).
// No channel filter is applied anywhere in this file.

const { getSupabase } = require('./_supabase');

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

    // ── 4. Calculate restock metrics per product ─────────────────────────────
    const todayStr  = today.toISOString().slice(0, 10);
    const LEAD_DAYS = 75;

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

      results.push({
        sku:             p.sku,
        nombre:          p.nombre,
        categoria:       p.categoria || '',
        stock:           stock,
        total_sold:      totalSold,
        active_days:     totalSold > 0 ? activeDays : null,
        daily_velocity:  Math.round(dailyVelocity * 100) / 100,
        days_coverage:   daysCoverage !== null ? Math.round(daysCoverage) : null,
        restock_date:    restockDate,
        stockout_date:   stockoutDate,
        already_ordered,
        en_transito:     transito,       // full detail array
        qty_en_transito,
        proxima_llegada,
        today:           todayStr,
      });
    }

    // Sort: most urgent first (earliest restock_date), already-ordered last
    results.sort((a, b) => {
      if (a.already_ordered !== b.already_ordered) return a.already_ordered ? 1 : -1;
      if (!a.restock_date) return 1;
      if (!b.restock_date) return -1;
      return a.restock_date < b.restock_date ? -1 : 1;
    });

    return res.json(results);
  } catch (err) {
    console.error('Error en /api/restock:', err);
    return res.status(500).json({ error: err.message });
  }
};
