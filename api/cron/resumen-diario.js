// api/cron/resumen-diario.js
// Cron job — se ejecuta todos los días a las 23:00 UTC (20:00 Uruguay)

const { getSupabase } = require('../_supabase');

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(err => console.error('Telegram error:', err.message));
}

module.exports = async (req, res) => {
  // Vercel solo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const hoy = new Date().toISOString().slice(0, 10);

  try {
    // Ventas del día
    const { data: ventas } = await supabase
      .from('ventas')
      .select('*')
      .eq('fecha', hoy);

    // Envíos pendientes
    const { data: envios } = await supabase
      .from('envios')
      .select('*')
      .in('estado', ['pendiente', 'en_camino']);

    // Productos con stock bajo
    const { data: productos } = await supabase
      .from('productos')
      .select('*')
      .order('stock_dep', { ascending: true });

    const stockBajo = (productos || []).filter(p => p.stock_dep <= p.alerta_min);
    const sinStock = stockBajo.filter(p => p.stock_dep === 0);

    const v = ventas || [];
    const totalIngresos = v.reduce((a, x) => a + x.total, 0);
    const totalComisiones = v.reduce((a, x) => a + (x.comision || 0), 0);
    const ventasMeli = v.filter(x => x.canal === 'meli');
    const ventasMostrador = v.filter(x => x.canal === 'mostrador');

    // Top producto del día
    const porProducto = {};
    v.forEach(x => {
      if (!porProducto[x.producto]) porProducto[x.producto] = { total: 0, cant: 0 };
      porProducto[x.producto].total += x.total;
      porProducto[x.producto].cant += x.cantidad;
    });
    const top = Object.entries(porProducto).sort((a, b) => b[1].total - a[1].total)[0];

    // Armar mensaje
    let msg = `📦 <b>Resumen del día — ${hoy}</b>\n\n`;

    if (v.length === 0) {
      msg += `🛒 Sin ventas hoy.\n`;
    } else {
      msg +=
        `💰 <b>Ingresos:</b> $${totalIngresos.toLocaleString('es-AR')}\n` +
        `🛒 <b>Ventas:</b> ${v.length} (🟡 MELI: ${ventasMeli.length} | 🏪 Mostrador: ${ventasMostrador.length})\n` +
        `💸 <b>Comisiones:</b> $${totalComisiones.toLocaleString('es-AR')}\n`;
      if (top) {
        msg += `🏆 <b>Más vendido:</b> ${top[0]} (${top[1].cant} uds)\n`;
      }
    }

    msg += `\n🚚 <b>Envíos activos:</b> ${(envios || []).length}`;

    if (stockBajo.length > 0) {
      msg += `\n\n⚠️ <b>Stock bajo (${stockBajo.length} productos):</b>\n`;
      msg += stockBajo.slice(0, 5).map(p =>
        `${p.stock_dep === 0 ? '🔴' : '🟡'} ${p.nombre} — ${p.stock_dep} uds`
      ).join('\n');
      if (stockBajo.length > 5) msg += `\n... y ${stockBajo.length - 5} más.`;
    } else {
      msg += `\n✅ <b>Stock:</b> Todo OK`;
    }

    await sendTelegram(msg);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Error en resumen diario:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
