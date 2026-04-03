// api/restock.js
// GET /api/restock
//
// Returns restock calendar data for every product:
//   - daily_velocity  = total units sold across ALL channels in last 30 days / 30
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
      .select('sku, nombre, categoria, stock_dep');
    if (prodErr) throw prodErr;

    // ── 2. Sales velocity: last 30 days, ALL channels, exclude cancelled ─────
    const today = new Date();
    const since = new Date(today);
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    const { data: ventas, error: ventasErr } = await supabase
      .from('ventas')
      .select('sku, cantidad')
      .gte('fecha', sinceStr)
      .neq('estado', 'cancelada');
    if (ventasErr) throw ventasErr;

    // Aggregate units sold by SKU (all channels combined)
    const soldBySku = {};
    for (const v of ventas) {
      soldBySku[v.sku] = (soldBySku[v.sku] || 0) + v.cantidad;
    }

    // ── 3. Pending imports: SKUs already covered by an active order ──────────
    const { data: pendingItems } = await supabase
      .from('import_items')
      .select('sku, imports!inner(status)')
      .neq('imports.status', 'arrived')
      .neq('imports.status', 'cancelled');

    const pendingSkus = new Set((pendingItems || []).map(i => i.sku));

    // ── 4. Calculate restock metrics per product ─────────────────────────────
    const todayStr  = today.toISOString().slice(0, 10);
    const LEAD_DAYS = 75;

    const results = [];

    for (const p of productos) {
      const totalSold30d  = soldBySku[p.sku] || 0;
      const dailyVelocity = totalSold30d / 30;
      const stock         = p.stock_dep || 0;

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

      results.push({
        sku:             p.sku,
        nombre:          p.nombre,
        categoria:       p.categoria || '',
        stock:           stock,
        total_sold_30d:  totalSold30d,
        daily_velocity:  Math.round(dailyVelocity * 100) / 100,
        days_coverage:   daysCoverage !== null ? Math.round(daysCoverage) : null,
        restock_date:    restockDate,
        stockout_date:   stockoutDate,
        already_ordered: pendingSkus.has(p.sku),
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
