// api/meli/ads-historico.js
// GET /api/meli/ads-historico?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// GET /api/meli/ads-historico?mes=YYYY-MM
// GET /api/meli/ads-historico?dias=N
//
// Lee el gasto de Ads desde meli_ads_diario (caché local, sin llamar a MELI).
// Una fila por día, así que sumar el rango da el gasto real del período.

const { getSupabase } = require('../_supabase');

const aFecha = d => d.toISOString().slice(0, 10);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { mes, desde: qDesde, hasta: qHasta } = req.query;
  const now = new Date();

  let fechaDesde, fechaHasta;
  if (qDesde || qHasta) {
    fechaDesde = qDesde || '2020-01-01';
    fechaHasta = qHasta || aFecha(now);
  } else if (mes) {
    const [anio, numMes] = mes.split('-').map(Number);
    fechaDesde = `${mes}-01`;
    fechaHasta = `${mes}-${String(new Date(anio, numMes, 0).getDate()).padStart(2, '0')}`;
  } else {
    const dias = parseInt(req.query.dias || '30', 10);
    fechaDesde = aFecha(new Date(now.getTime() - dias * 86400000));
    fechaHasta = aFecha(now);
  }

  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('meli_ads_diario')
      .select('fecha, spend, clicks, impressions, facturacion')
      .gte('fecha', fechaDesde)
      .lte('fecha', fechaHasta)
      .order('fecha', { ascending: true });

    if (error) throw error;

    const porDia = (data || []).map(d => ({
      fecha: d.fecha,
      spend: parseFloat(d.spend || 0),
      clicks: parseInt(d.clicks || 0, 10),
      impressions: parseInt(d.impressions || 0, 10),
      facturacion: parseFloat(d.facturacion || 0),
    }));

    const total_spend = porDia.reduce((a, d) => a + d.spend, 0);
    const total_facturacion = porDia.reduce((a, d) => a + d.facturacion, 0);

    return res.json({
      ok: true,
      periodo: { desde: fechaDesde, hasta: fechaHasta },
      total_spend,
      total_facturacion,
      roas: total_spend > 0 ? parseFloat((total_facturacion / total_spend).toFixed(2)) : 0,
      clicks: porDia.reduce((a, d) => a + d.clicks, 0),
      impressions: porDia.reduce((a, d) => a + d.impressions, 0),
      dias_con_datos: porDia.length,
      // Huecos dentro del tramo que sí tiene datos. Se mide entre el primer y el último día
      // capturado, no contra el rango pedido: pedir "desde 2020" no significa que falten
      // cinco años de Ads, sólo que la cuenta no existía. Un hueco acá sí es un día perdido.
      dias_sin_datos: porDia.length
        ? Math.max(
            0,
            Math.round((new Date(porDia[porDia.length - 1].fecha) - new Date(porDia[0].fecha)) / 86400000)
              + 1 - porDia.length
          )
        : 0,
      por_dia: porDia,
    });

  } catch (err) {
    console.error('Error en ads-historico.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
