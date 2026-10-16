// api/meli/ads-economia.js
// GET /api/meli/ads-economia
//
// La comisión y el envío por unidad de cada SKU, medidos sobre las ventas reales: lo mismo
// que usa la tabla de anuncios para el ROAS de equilibrio, pero para el catálogo entero.
//
// Lo usa la sección 💰 Productos por margen para pasar del margen bruto (precio − costo)
// al margen real (− comisión − envío), que es el que decide cuánto se puede pagar por
// una venta traída con ads. Sin esto, un producto de 40% bruto con envío caro queda en
// la campaña de margen alto cuando en realidad deja 15%.

const { getSupabase } = require('../_supabase');
const { cargarEconomia, deSku } = require('./_economia');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();
    const [{ data: productos, error }, economia] = await Promise.all([
      supabase.from('productos').select('sku'),
      cargarEconomia(supabase),
    ]);
    if (error) throw error;

    const porSku = {};
    for (const p of productos || []) {
      if (!p.sku) continue;
      const e = deSku(economia, p.sku);
      porSku[String(p.sku).trim().toUpperCase()] = {
        comision_pct: e.comision_pct,
        envio_unitario: e.envio_unitario,
        fuente: e.fuente,
        ventas_muestra: e.ventas_muestra,
      };
    }
    return res.json({ ok: true, global: economia.global, periodo: economia.periodo, por_sku: porSku });
  } catch (err) {
    console.error('Error en ads-economia.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
