// api/cron/resumen-diario.js
// Cron job — se ejecuta todos los días a las 23:00 UTC (20:00 Uruguay)

const { getSupabase } = require('../_supabase');
const { esc, enviar } = require('../_telegram');

// El día de Montevideo, no el del servidor (UTC): a partir de las 21:00 de Uruguay en UTC ya
// es mañana, y el resumen salía vacío o con el día equivocado.
function hoyEnUruguay(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(fecha);
}

const pesos = n => `$${Math.round(n || 0).toLocaleString('es-AR')}`;

const CANALES = [
  ['meli', '🟡 MELI'],
  ['shopify', '🛍️ Shopify'],
  ['mostrador', '🏪 Mostrador'],
];

function armarResumen({ fecha, ventas, envios, productos }) {
  // Las canceladas (devoluciones, pedidos de Shopify cancelados) no son ventas del día.
  const v = (ventas || []).filter(x => x.estado !== 'cancelada');
  let msg = `📦 <b>Resumen del día — ${fecha}</b>\n\n`;

  if (v.length === 0) {
    msg += `🛒 Sin ventas hoy.\n`;
  } else {
    const ingresos = v.reduce((a, x) => a + (x.total || 0), 0);
    const comisiones = v.reduce((a, x) => a + (x.comision || 0), 0);
    const porCanal = CANALES
      .map(([canal, etiqueta]) => [etiqueta, v.filter(x => x.canal === canal).length])
      .filter(([, n]) => n > 0)
      .map(([etiqueta, n]) => `${etiqueta}: ${n}`);
    const otros = v.filter(x => !CANALES.some(([c]) => c === x.canal)).length;
    if (otros) porCanal.push(`Otros: ${otros}`);

    msg +=
      `💰 <b>Ingresos:</b> ${pesos(ingresos)}\n` +
      `🛒 <b>Ventas:</b> ${v.length} (${porCanal.join(' | ')})\n` +
      `💸 <b>Comisiones:</b> ${pesos(comisiones)}\n`;

    const porProducto = {};
    for (const x of v) {
      const p = (porProducto[x.producto] ||= { total: 0, cant: 0 });
      p.total += x.total || 0;
      p.cant += x.cantidad || 0;
    }
    const top = Object.entries(porProducto).sort((a, b) => b[1].total - a[1].total)[0];
    if (top) msg += `🏆 <b>Más vendido:</b> ${esc(top[0])} (${top[1].cant} uds)\n`;
  }

  const e = envios || [];
  const pendientes = e.filter(x => x.estado === 'pendiente').length;
  msg += `\n🚚 <b>Envíos activos:</b> ${e.length}` +
    (e.length ? ` (⏳ sin despachar: ${pendientes} | en camino: ${e.length - pendientes})` : '');

  // Los descatalogados no se reponen: no cuentan como stock bajo.
  const stockBajo = (productos || [])
    .filter(p => !p.discontinuado && (p.stock_dep ?? 0) <= (p.alerta_min ?? 0))
    .sort((a, b) => (a.stock_dep ?? 0) - (b.stock_dep ?? 0));
  if (stockBajo.length > 0) {
    msg += `\n\n⚠️ <b>Stock bajo (${stockBajo.length} productos):</b>\n`;
    msg += stockBajo.slice(0, 5).map(p =>
      `${p.stock_dep === 0 ? '🔴' : '🟡'} ${esc(p.nombre)} — ${p.stock_dep} uds`
    ).join('\n');
    if (stockBajo.length > 5) msg += `\n... y ${stockBajo.length - 5} más.`;
  } else {
    msg += `\n✅ <b>Stock:</b> Todo OK`;
  }

  return msg;
}

module.exports = async (req, res) => {
  // Vercel solo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const fecha = hoyEnUruguay();

  try {
    const [ventasRes, enviosRes, productosRes] = await Promise.all([
      supabase.from('ventas').select('canal, estado, producto, cantidad, total, comision').eq('fecha', fecha),
      supabase.from('envios').select('estado').in('estado', ['pendiente', 'en_camino']),
      supabase.from('productos').select('nombre, stock_dep, alerta_min, discontinuado'),
    ]);
    const error = ventasRes.error || enviosRes.error || productosRes.error;
    if (error) throw new Error(error.message);

    await enviar(armarResumen({
      fecha,
      ventas: ventasRes.data,
      envios: enviosRes.data,
      productos: productosRes.data,
    }));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error en resumen diario:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.armarResumen = armarResumen;
module.exports.hoyEnUruguay = hoyEnUruguay;
