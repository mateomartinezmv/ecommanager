// api/telegram/webhook.js
// POST /api/telegram/webhook → recibe mensajes del bot y responde

const { getSupabase } = require('../_supabase');

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(err => console.error('Telegram send error:', err.message));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const message = req.body?.message;
  if (!message || !message.text) return res.status(200).json({ ok: true });

  // Solo responder al chat autorizado
  const chatId = String(message.chat.id);
  if (chatId !== process.env.TELEGRAM_CHAT_ID) return res.status(200).json({ ok: true });

  const texto = message.text.toLowerCase().trim();
  const supabase = getSupabase();

  try {
    // ── comandos ─────────────────────────────────────────────
    if (texto === 'comandos') {
      await sendTelegram(chatId,
        `🏍️ <b>Martinez Motos Bot — Comandos</b>\n\n` +
        `📦 <b>stock</b> — productos con stock bajo\n` +
        `📊 <b>ventas hoy</b> — resumen del día\n` +
        `📅 <b>ventas mes</b> — resumen del mes\n` +
        `🚚 <b>envios</b> — envíos pendientes\n` +
        `💰 <b>ganancia</b> — ganancia estimada del mes\n` +
        `🤖 <b>recomendaciones</b> — análisis IA de tu negocio`
      );
    }

    // ── stock ────────────────────────────────────────────────
    else if (texto.includes('stock')) {
      const { data: productos } = await supabase
        .from('productos')
        .select('*')
        .order('stock_dep', { ascending: true });

      const bajos = productos.filter(p => p.stock_dep <= p.alerta_min);
      const sinStock = productos.filter(p => p.stock_dep === 0);

      if (bajos.length === 0) {
        await sendTelegram(chatId, '✅ <b>Stock OK</b>\n\nTodos los productos están sobre el mínimo.');
      } else {
        const lineas = bajos.map(p =>
          `${p.stock_dep === 0 ? '🔴' : '🟡'} <b>${p.nombre}</b>\n   Depósito: ${p.stock_dep} | MELI: ${p.stock_meli} | Mín: ${p.alerta_min}`
        ).join('\n\n');
        await sendTelegram(chatId,
          `📦 <b>Stock bajo (${bajos.length} productos)</b>\n` +
          `🔴 Sin stock: ${sinStock.length} | 🟡 Bajo mínimo: ${bajos.length - sinStock.length}\n\n` +
          lineas
        );
      }
    }

    // ── ventas hoy ───────────────────────────────────────────
    else if (texto.includes('ventas hoy') || texto === 'hoy') {
      const hoy = new Date().toISOString().slice(0, 10);
      const { data: ventas } = await supabase.from('ventas').select('*').eq('fecha', hoy);

      if (!ventas || ventas.length === 0) {
        await sendTelegram(chatId, `📊 <b>Ventas hoy (${hoy})</b>\n\nSin ventas registradas por ahora.`);
      } else {
        const total = ventas.reduce((a, v) => a + v.total, 0);
        const comisiones = ventas.reduce((a, v) => a + (v.comision || 0), 0);
        const meli = ventas.filter(v => v.canal === 'meli');
        const mostrador = ventas.filter(v => v.canal === 'mostrador');
        const detalle = ventas.map(v =>
          `• ${v.producto} x${v.cantidad} — $${v.total.toLocaleString('es-AR')}`
        ).join('\n');
        await sendTelegram(chatId,
          `📊 <b>Ventas hoy — ${hoy}</b>\n\n` +
          `💰 Total: <b>$${total.toLocaleString('es-AR')}</b>\n` +
          `🛒 Ventas: ${ventas.length} (🟡 MELI: ${meli.length} | 🏪 Mostrador: ${mostrador.length})\n` +
          `💸 Comisiones: $${comisiones.toLocaleString('es-AR')}\n\n` +
          `<b>Detalle:</b>\n${detalle}`
        );
      }
    }

    // ── ventas mes ───────────────────────────────────────────
    else if (texto.includes('ventas mes') || texto === 'mes') {
      const now = new Date();
      const primeroDeMes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const { data: ventas } = await supabase.from('ventas').select('*').gte('fecha', primeroDeMes);

      if (!ventas || ventas.length === 0) {
        await sendTelegram(chatId, `📅 <b>Ventas este mes</b>\n\nSin ventas registradas este mes.`);
      } else {
        const total = ventas.reduce((a, v) => a + v.total, 0);
        const comisiones = ventas.reduce((a, v) => a + (v.comision || 0), 0);
        const meli = ventas.filter(v => v.canal === 'meli');
        const mostrador = ventas.filter(v => v.canal === 'mostrador');
        const totalMeli = meli.reduce((a, v) => a + v.total, 0);
        const totalMostrador = mostrador.reduce((a, v) => a + v.total, 0);
        const porProducto = {};
        ventas.forEach(v => {
          if (!porProducto[v.producto]) porProducto[v.producto] = { total: 0, cant: 0 };
          porProducto[v.producto].total += v.total;
          porProducto[v.producto].cant += v.cantidad;
        });
        const top3 = Object.entries(porProducto)
          .sort((a, b) => b[1].total - a[1].total)
          .slice(0, 3)
          .map(([nombre, d], i) => `${['🥇','🥈','🥉'][i]} ${nombre} — $${d.total.toLocaleString('es-AR')} (${d.cant} uds)`)
          .join('\n');
        await sendTelegram(chatId,
          `📅 <b>Ventas este mes</b>\n\n` +
          `💰 Total: <b>$${total.toLocaleString('es-AR')}</b>\n` +
          `🛒 Ventas: ${ventas.length}\n` +
          `🟡 MELI: $${totalMeli.toLocaleString('es-AR')} (${meli.length} ventas)\n` +
          `🏪 Mostrador: $${totalMostrador.toLocaleString('es-AR')} (${mostrador.length} ventas)\n` +
          `💸 Comisiones: $${comisiones.toLocaleString('es-AR')}\n\n` +
          `<b>Top productos:</b>\n${top3}`
        );
      }
    }

    // ── envios ───────────────────────────────────────────────
    else if (texto.includes('envio') || texto.includes('envío')) {
      const { data: envios } = await supabase
        .from('envios')
        .select('*')
        .in('estado', ['pendiente', 'en_camino'])
        .order('created_at', { ascending: false });

      if (!envios || envios.length === 0) {
        await sendTelegram(chatId, '🚚 <b>Envíos pendientes</b>\n\nNo hay envíos pendientes. ✅');
      } else {
        const pendientes = envios.filter(e => e.estado === 'pendiente');
        const enCamino = envios.filter(e => e.estado === 'en_camino');
        const lineas = envios.map(e =>
          `${e.estado === 'en_camino' ? '🚚' : '⏳'} <b>${e.comprador || 'Sin nombre'}</b>\n` +
          `   ${e.producto || '—'} | ${e.tracking ? `Tracking: ${e.tracking}` : 'Sin tracking'}`
        ).join('\n\n');
        await sendTelegram(chatId,
          `🚚 <b>Envíos activos (${envios.length})</b>\n` +
          `⏳ Pendientes: ${pendientes.length} | 🚚 En camino: ${enCamino.length}\n\n` +
          lineas
        );
      }
    }

    // ── ganancia ─────────────────────────────────────────────
    else if (texto.includes('ganancia')) {
      const now = new Date();
      const primeroDeMes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const [ventasRes, productosRes] = await Promise.all([
        supabase.from('ventas').select('*').gte('fecha', primeroDeMes),
        supabase.from('productos').select('sku, costo'),
      ]);
      const ventas = ventasRes.data || [];
      const productos = productosRes.data || [];

      if (ventas.length === 0) {
        await sendTelegram(chatId, '💰 <b>Ganancia este mes</b>\n\nSin ventas registradas este mes.');
      } else {
        const costoMap = {};
        productos.forEach(p => { costoMap[p.sku] = p.costo; });
        let ingresos = 0, comisiones = 0, costos = 0;
        ventas.forEach(v => {
          ingresos += v.total;
          comisiones += v.comision || 0;
          costos += (costoMap[v.sku] || 0) * v.cantidad;
        });
        const ganancia = ingresos - comisiones - costos;
        const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;
        await sendTelegram(chatId,
          `💰 <b>Ganancia estimada — este mes</b>\n\n` +
          `📈 Ingresos: $${ingresos.toLocaleString('es-AR')}\n` +
          `💸 Comisiones MELI: -$${comisiones.toLocaleString('es-AR')}\n` +
          `🏭 Costo de productos: -$${costos.toLocaleString('es-AR')}\n` +
          `─────────────────\n` +
          `✅ <b>Ganancia: $${ganancia.toLocaleString('es-AR')}</b>\n` +
          `📊 Margen: ${margen}%` +
          (costos === 0 ? '\n\n⚠️ <i>Los costos están en $0. Cargalos en cada producto para un cálculo preciso.</i>' : '')
        );
      }
    }

    // ── recomendaciones ──────────────────────────────────────
    else if (texto.includes('recomendacion') || texto.includes('recomendación') || texto.includes('mejorar')) {
      await sendTelegram(chatId, '🤖 <b>Analizando tus datos...</b> Un momento.');

      const now = new Date();
      const primeroDeMes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const [ventasRes, productosRes, enviosRes] = await Promise.all([
        supabase.from('ventas').select('*').gte('fecha', primeroDeMes),
        supabase.from('productos').select('*'),
        supabase.from('envios').select('*').in('estado', ['pendiente', 'en_camino']),
      ]);
      const ventas = ventasRes.data || [];
      const productos = productosRes.data || [];
      const envios = enviosRes.data || [];

      const totalIngresos = ventas.reduce((a, v) => a + v.total, 0);
      const totalComisiones = ventas.reduce((a, v) => a + (v.comision || 0), 0);
      const stockBajo = productos.filter(p => p.stock_dep <= p.alerta_min);
      const sinStock = productos.filter(p => p.stock_dep === 0);
      const ventasMeli = ventas.filter(v => v.canal === 'meli');
      const ventasMostrador = ventas.filter(v => v.canal === 'mostrador');

      const porProducto = {};
      ventas.forEach(v => {
        if (!porProducto[v.producto]) porProducto[v.producto] = { total: 0, cant: 0 };
        porProducto[v.producto].total += v.total;
        porProducto[v.producto].cant += v.cantidad;
      });
      const topProductos = Object.entries(porProducto)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 5)
        .map(([nombre, d]) => `${nombre}: $${d.total} (${d.cant} unidades)`);
      const productosSinVenta = productos
        .filter(p => !ventas.find(v => v.sku === p.sku))
        .map(p => p.nombre).slice(0, 5);

      const prompt = `Soy dueño de una tienda de accesorios para motos en Uruguay llamada Martinez Motos. Vendemos por Mercado Libre y mostrador físico.

DATOS DEL MES ACTUAL:
- Ventas totales: ${ventas.length} (MELI: ${ventasMeli.length}, Mostrador: ${ventasMostrador.length})
- Ingresos: $${totalIngresos.toLocaleString('es-AR')}
- Comisiones MELI: $${totalComisiones.toLocaleString('es-AR')}
- Envíos pendientes/en camino: ${envios.length}

STOCK:
- Total productos: ${productos.length}
- Productos sin stock: ${sinStock.length} (${sinStock.map(p => p.nombre).slice(0,3).join(', ')})
- Productos con stock bajo: ${stockBajo.length}

TOP 5 PRODUCTOS MÁS VENDIDOS ESTE MES:
${topProductos.join('\n')}

PRODUCTOS SIN NINGUNA VENTA ESTE MES:
${productosSinVenta.join(', ') || 'Ninguno'}

Dame 4 o 5 recomendaciones concretas, cortas y accionables para mejorar las ventas, el stock o la operación. Sé directo, sin vueltas. Formato: cada recomendación con un emoji relevante al inicio y máximo 2 líneas.`;

      const iaRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const iaData = await iaRes.json();
      const recomendaciones = iaData.content?.[0]?.text || 'No se pudo generar el análisis.';
      await sendTelegram(chatId, `🤖 <b>Recomendaciones para Martinez Motos</b>\n\n${recomendaciones}`);
    }

    // ── ayuda (default) ──────────────────────────────────────
    else {
      await sendTelegram(chatId,
        `🏍️ <b>Martinez Motos Bot</b>\n\n` +
        `Comandos disponibles:\n\n` +
        `📦 <b>stock</b> — productos con stock bajo\n` +
        `📊 <b>ventas hoy</b> — resumen del día\n` +
        `📅 <b>ventas mes</b> — resumen del mes\n` +
        `🚚 <b>envios</b> — envíos pendientes\n` +
        `💰 <b>ganancia</b> — ganancia estimada del mes\n` +
        `🤖 <b>recomendaciones</b> — análisis IA de tu negocio`
      );
    }

  } catch (err) {
    console.error('Error en webhook Telegram:', err.message);
    await sendTelegram(chatId, '❌ Ocurrió un error procesando tu consulta.');
  }

  // Responder a Telegram al final, cuando todo ya se procesó
  return res.status(200).json({ ok: true });
};
