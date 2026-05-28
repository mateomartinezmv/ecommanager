// api/telegram/webhook.js
const { getSupabase } = require('../_supabase');

const MENU = `🏍️ <b>Martinez Motos Bot</b>\n\n` +
  `<b>Consultas:</b>\n` +
  `📦 <b>stock</b> — productos con stock bajo\n` +
  `📊 <b>ventas hoy</b> — resumen del día\n` +
  `📅 <b>ventas mes</b> — resumen del mes\n` +
  `🚚 <b>envios</b> — envíos pendientes\n` +
  `💰 <b>ganancia</b> — ganancia estimada del mes\n` +
  `🤖 <b>recomendaciones</b> — análisis IA\n\n` +
  `<b>Acciones (texto libre):</b>\n` +
  `🛒 "vendí 2 señaleros a $1500 efectivo"\n` +
  `📦 "agregá casco Shiro talle M precio $4500 stock 3"\n` +
  `🚚 "despachá orden 2000001234 tracking AN123456"\n` +
  `✅ "entregado el envío de Juan Pérez"\n` +
  `↩️ "devolución de 1 espejo gaviota SKU ESP-001"\n` +
  `🔍 "qué necesito reponer?"`;

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(err => console.error('Telegram send error:', err.message));
}

// Guarda acción pendiente de confirmación
async function setPendiente(supabase, chatId, accion) {
  await supabase.from('bot_estado').upsert({
    chat_id: chatId,
    accion_pendiente: accion,
    updated_at: new Date().toISOString(),
  });
}

// Lee y limpia acción pendiente
async function getPendiente(supabase, chatId) {
  const { data } = await supabase.from('bot_estado').select('accion_pendiente').eq('chat_id', chatId).single();
  if (data?.accion_pendiente) {
    await supabase.from('bot_estado').update({ accion_pendiente: null }).eq('chat_id', chatId);
  }
  return data?.accion_pendiente || null;
}

// Llama a Claude para interpretar texto libre
async function interpretarMensaje(texto, contexto) {
  const prompt = `Sos el asistente de gestión de Martinez Motos, una tienda de accesorios para motos en Uruguay.

El dueño te mandó este mensaje: "${texto}"

Contexto disponible (productos existentes):
${contexto}

Tu tarea es identificar si el mensaje es una ACCIÓN (venta, despacho, entrega, devolución, nuevo producto, reposición) o una CONSULTA.

Respondé SOLO con un JSON válido, sin texto adicional, con esta estructura según el tipo:

Para VENTA DE MOSTRADOR:
{"tipo":"venta","producto":"nombre o SKU mencionado","sku":"SKU si lo mencionó o null","cantidad":1,"precio":0,"metodoPago":"efectivo|debito|credito|transferencia|qr","cliente":"nombre si lo mencionó o null","resumen":"Registrar venta de X unidades de [producto] a $Y por [método]. Cliente: [nombre o 'sin especificar']"}

Para DESPACHO DE ENVÍO:
{"tipo":"despacho","orden":"número de orden o identificador","tracking":"código o null","transportista":"andreani|oca|correo_arg|mercado_envios|otro","resumen":"Marcar envío de orden [X] como despachado con tracking [Y]"}

Para ENTREGA:
{"tipo":"entrega","orden":"número de orden, nombre del comprador, o identificador","resumen":"Marcar envío de [X] como entregado"}

Para DEVOLUCIÓN:
{"tipo":"devolucion","sku":"SKU del producto o null","producto":"nombre del producto","cantidad":1,"resumen":"Registrar devolución de [X] unidades de [producto] y reponer stock"}

Para NUEVO PRODUCTO:
{"tipo":"nuevo_producto","sku":"SKU si lo mencionó o autogenerar con formato CAT-001","nombre":"nombre del producto","precio":0,"stock":0,"costo":0,"categoria":"categoría o null","resumen":"Crear producto [nombre] SKU [X] precio $Y stock Z"}

Para REPOSICIÓN:
{"tipo":"reposicion","resumen":"Consulta de reposición"}

Para CONSULTA o mensaje no reconocido:
{"tipo":"consulta","resumen":"no_reconocido"}

Importante: si falta información crítica (como precio en una venta), igualmente armá el JSON con lo que tenés y dejá el campo en 0 o null.`;

  const iaRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const iaData = await iaRes.json();
  const raw = iaData.content?.[0]?.text || '{}';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { tipo: 'consulta', resumen: 'no_reconocido' };
  }
}

// ── EJECUTORES ───────────────────────────────────────────────

async function ejecutarVenta(supabase, accion) {
  // Buscar el producto por SKU o nombre
  let producto = null;
  if (accion.sku) {
    const { data } = await supabase.from('productos').select('*').eq('sku', accion.sku).single();
    producto = data;
  }
  if (!producto && accion.producto) {
    const { data } = await supabase.from('productos').select('*').ilike('nombre', `%${accion.producto}%`).limit(1).single();
    producto = data;
  }
  if (!producto) return `❌ No encontré el producto "${accion.producto || accion.sku}" en el inventario.`;

  const cantidad = accion.cantidad || 1;
  const precio = accion.precio || producto.precio;
  const total = precio * cantidad;
  const nuevoStock = Math.max(0, producto.stock_dep - cantidad);

  const ventaId = 'V' + Date.now();
  const hoy = new Date().toISOString().slice(0, 10);

  const { error: ventaErr } = await supabase.from('ventas').insert({
    id: ventaId,
    canal: 'mostrador',
    fecha: hoy,
    cliente: accion.cliente || null,
    sku: producto.sku,
    producto: producto.nombre,
    cantidad,
    precio_unit: precio,
    comision: 0,
    total,
    estado: 'pagada',
    metodo_pago: accion.metodoPago || 'efectivo',
    genera_envio: false,
  });
  if (ventaErr) return `❌ Error registrando venta: ${ventaErr.message}`;

  await supabase.from('productos').update({
    stock_dep: nuevoStock,
    updated_at: new Date().toISOString(),
  }).eq('sku', producto.sku);

  return `✅ <b>Venta registrada</b>\n\n` +
    `📦 ${producto.nombre} x${cantidad}\n` +
    `💰 Total: $${total.toLocaleString('es-AR')}\n` +
    `💳 Pago: ${accion.metodoPago || 'efectivo'}\n` +
    `📊 Stock restante: ${nuevoStock} uds` +
    (nuevoStock <= producto.alerta_min ? '\n⚠️ <b>Stock bajo mínimo</b>' : '');
}

async function ejecutarDespacho(supabase, accion) {
  // Buscar envío por orden
  const { data: envios } = await supabase.from('envios').select('*')
    .or(`orden.ilike.%${accion.orden}%,id.ilike.%${accion.orden}%`)
    .in('estado', ['pendiente']);

  if (!envios || envios.length === 0) {
    return `❌ No encontré ningún envío pendiente con la orden "${accion.orden}".`;
  }

  const envio = envios[0];
  await supabase.from('envios').update({
    estado: 'en_camino',
    tracking: accion.tracking || envio.tracking,
    transportista: accion.transportista || envio.transportista,
    fecha_despacho: new Date().toISOString().slice(0, 10),
  }).eq('id', envio.id);

  return `✅ <b>Envío despachado</b>\n\n` +
    `👤 ${envio.comprador || 'Sin nombre'}\n` +
    `📦 ${envio.producto || '—'}\n` +
    `🚚 Tracking: ${accion.tracking || 'sin tracking'}\n` +
    `📬 Transportista: ${accion.transportista || envio.transportista}`;
}

async function ejecutarEntrega(supabase, accion) {
  const { data: envios } = await supabase.from('envios').select('*')
    .or(`orden.ilike.%${accion.orden}%,comprador.ilike.%${accion.orden}%`)
    .in('estado', ['pendiente', 'en_camino']);

  if (!envios || envios.length === 0) {
    return `❌ No encontré ningún envío activo con "${accion.orden}".`;
  }

  const envio = envios[0];
  await supabase.from('envios').update({ estado: 'entregado' }).eq('id', envio.id);

  return `✅ <b>Envío marcado como entregado</b>\n\n` +
    `👤 ${envio.comprador || 'Sin nombre'}\n` +
    `📦 ${envio.producto || '—'}`;
}

async function ejecutarDevolucion(supabase, accion) {
  let producto = null;
  if (accion.sku) {
    const { data } = await supabase.from('productos').select('*').eq('sku', accion.sku).single();
    producto = data;
  }
  if (!producto && accion.producto) {
    const { data } = await supabase.from('productos').select('*').ilike('nombre', `%${accion.producto}%`).limit(1).single();
    producto = data;
  }
  if (!producto) return `❌ No encontré el producto "${accion.producto || accion.sku}".`;

  const cantidad = accion.cantidad || 1;
  const nuevoStock = producto.stock_dep + cantidad;

  await supabase.from('productos').update({
    stock_dep: nuevoStock,
    updated_at: new Date().toISOString(),
  }).eq('sku', producto.sku);

  // Registrar como venta cancelada
  await supabase.from('ventas').insert({
    id: 'DEV' + Date.now(),
    canal: 'mostrador',
    fecha: new Date().toISOString().slice(0, 10),
    sku: producto.sku,
    producto: producto.nombre,
    cantidad,
    precio_unit: 0,
    comision: 0,
    total: 0,
    estado: 'cancelada',
    notas: 'Devolución',
    genera_envio: false,
  });

  return `↩️ <b>Devolución registrada</b>\n\n` +
    `📦 ${producto.nombre} x${cantidad}\n` +
    `📊 Stock actualizado: ${nuevoStock} uds`;
}

async function ejecutarNuevoProducto(supabase, accion) {
  const sku = accion.sku || ('PROD-' + Date.now().toString().slice(-6));
  const { error } = await supabase.from('productos').insert({
    sku,
    nombre: accion.nombre,
    categoria: accion.categoria || '',
    stock_dep: accion.stock || 0,
    stock_meli: 0,
    costo: accion.costo || 0,
    precio: accion.precio || 0,
    alerta_min: 3,
    notas: 'Creado desde bot Telegram',
  });
  if (error) return `❌ Error creando producto: ${error.message}`;

  return `✅ <b>Producto creado</b>\n\n` +
    `🏷️ SKU: ${sku}\n` +
    `📦 ${accion.nombre}\n` +
    `💰 Precio: $${(accion.precio || 0).toLocaleString('es-AR')}\n` +
    `📊 Stock inicial: ${accion.stock || 0} uds`;
}

async function ejecutarReposicion(supabase) {
  const { data: productos } = await supabase.from('productos').select('*').order('stock_dep', { ascending: true });
  const bajos = productos.filter(p => p.stock_dep <= p.alerta_min);
  const sinStock = bajos.filter(p => p.stock_dep === 0);
  const conPocoStock = bajos.filter(p => p.stock_dep > 0);

  if (bajos.length === 0) return '✅ <b>No necesitás reponer nada</b>\n\nTodo el stock está sobre el mínimo.';

  const lineas = [
    ...sinStock.map(p => `🔴 <b>${p.nombre}</b> (${p.sku}) — SIN STOCK`),
    ...conPocoStock.map(p => `🟡 <b>${p.nombre}</b> (${p.sku}) — ${p.stock_dep} uds (mín: ${p.alerta_min})`),
  ].join('\n');

  return `🔍 <b>Productos a reponer (${bajos.length})</b>\n\n${lineas}`;
}

// ── HANDLER PRINCIPAL ────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const message = req.body?.message;
  if (!message || !message.text) return res.status(200).json({ ok: true });

  const chatId = String(message.chat.id);
  if (chatId !== process.env.TELEGRAM_CHAT_ID) return res.status(200).json({ ok: true });

  const texto = message.text.trim();
  const textoLower = texto.toLowerCase();
  const supabase = getSupabase();

  try {
    // ── Confirmación pendiente ───────────────────────────────
    if (textoLower === 'si' || textoLower === 'sí' || textoLower === 'confirmar') {
      const accion = await getPendiente(supabase, chatId);
      if (!accion) return (await sendTelegram(chatId, '⚠️ No hay ninguna acción pendiente de confirmar.'), res.status(200).json({ ok: true }));

      let resultado = '';
      if (accion.tipo === 'venta')           resultado = await ejecutarVenta(supabase, accion);
      else if (accion.tipo === 'despacho')   resultado = await ejecutarDespacho(supabase, accion);
      else if (accion.tipo === 'entrega')    resultado = await ejecutarEntrega(supabase, accion);
      else if (accion.tipo === 'devolucion') resultado = await ejecutarDevolucion(supabase, accion);
      else if (accion.tipo === 'nuevo_producto') resultado = await ejecutarNuevoProducto(supabase, accion);
      else if (accion.tipo === 'reposicion') resultado = await ejecutarReposicion(supabase);
      else resultado = '❌ Acción no reconocida.';

      await sendTelegram(chatId, resultado);
      return res.status(200).json({ ok: true });
    }

    // ── Cancelar acción pendiente ────────────────────────────
    if (textoLower === 'no' || textoLower === 'cancelar') {
      await supabase.from('bot_estado').update({ accion_pendiente: null }).eq('chat_id', chatId);
      await sendTelegram(chatId, '❌ Acción cancelada.');
      return res.status(200).json({ ok: true });
    }

    // ── Comandos de consulta ─────────────────────────────────
    if (textoLower === 'comandos' || textoLower === '/start') {
      await sendTelegram(chatId, MENU);
      return res.status(200).json({ ok: true });
    }

    if (textoLower.includes('stock') && !textoLower.includes('stock ')) {
      const { data: productos } = await supabase.from('productos').select('*').order('stock_dep', { ascending: true });
      const bajos = productos.filter(p => p.stock_dep <= p.alerta_min);
      const sinStock = productos.filter(p => p.stock_dep === 0);
      if (bajos.length === 0) {
        await sendTelegram(chatId, '✅ <b>Stock OK</b>\n\nTodos los productos están sobre el mínimo.');
      } else {
        const lineas = bajos.map(p =>
          `${p.stock_dep === 0 ? '🔴' : '🟡'} <b>${p.nombre}</b>\n   Depósito: ${p.stock_dep} | MELI: ${p.stock_meli} | Mín: ${p.alerta_min}`
        ).join('\n\n');
        await sendTelegram(chatId,
          `📦 <b>Stock bajo (${bajos.length} productos)</b>\n🔴 Sin stock: ${sinStock.length} | 🟡 Bajo mínimo: ${bajos.length - sinStock.length}\n\n${lineas}`
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (textoLower.includes('ventas hoy') || textoLower === 'hoy') {
      const hoy = new Date().toISOString().slice(0, 10);
      const { data: ventas } = await supabase.from('ventas').select('*').eq('fecha', hoy);
      if (!ventas || ventas.length === 0) {
        await sendTelegram(chatId, `📊 <b>Ventas hoy (${hoy})</b>\n\nSin ventas registradas por ahora.`);
      } else {
        const total = ventas.reduce((a, v) => a + v.total, 0);
        const comisiones = ventas.reduce((a, v) => a + (v.comision || 0), 0);
        const meli = ventas.filter(v => v.canal === 'meli');
        const mostrador = ventas.filter(v => v.canal === 'mostrador');
        const detalle = ventas.map(v => `• ${v.producto} x${v.cantidad} — $${v.total.toLocaleString('es-AR')}`).join('\n');
        await sendTelegram(chatId,
          `📊 <b>Ventas hoy — ${hoy}</b>\n\n💰 Total: <b>$${total.toLocaleString('es-AR')}</b>\n🛒 Ventas: ${ventas.length} (🟡 MELI: ${meli.length} | 🏪 Mostrador: ${mostrador.length})\n💸 Comisiones: $${comisiones.toLocaleString('es-AR')}\n\n<b>Detalle:</b>\n${detalle}`
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (textoLower.includes('ventas mes') || textoLower === 'mes') {
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
        const porProducto = {};
        ventas.forEach(v => {
          if (!porProducto[v.producto]) porProducto[v.producto] = { total: 0, cant: 0 };
          porProducto[v.producto].total += v.total;
          porProducto[v.producto].cant += v.cantidad;
        });
        const top3 = Object.entries(porProducto).sort((a, b) => b[1].total - a[1].total).slice(0, 3)
          .map(([nombre, d], i) => `${['🥇','🥈','🥉'][i]} ${nombre} — $${d.total.toLocaleString('es-AR')} (${d.cant} uds)`).join('\n');
        await sendTelegram(chatId,
          `📅 <b>Ventas este mes</b>\n\n💰 Total: <b>$${total.toLocaleString('es-AR')}</b>\n🛒 Ventas: ${ventas.length}\n🟡 MELI: $${meli.reduce((a,v)=>a+v.total,0).toLocaleString('es-AR')} (${meli.length})\n🏪 Mostrador: $${mostrador.reduce((a,v)=>a+v.total,0).toLocaleString('es-AR')} (${mostrador.length})\n💸 Comisiones: $${comisiones.toLocaleString('es-AR')}\n\n<b>Top productos:</b>\n${top3}`
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (textoLower.includes('envio') || textoLower.includes('envío')) {
      const { data: envios } = await supabase.from('envios').select('*').in('estado', ['pendiente', 'en_camino']).order('created_at', { ascending: false });
      if (!envios || envios.length === 0) {
        await sendTelegram(chatId, '🚚 <b>Envíos pendientes</b>\n\nNo hay envíos pendientes. ✅');
      } else {
        const pendientes = envios.filter(e => e.estado === 'pendiente');
        const enCamino = envios.filter(e => e.estado === 'en_camino');
        const lineas = envios.map(e =>
          `${e.estado === 'en_camino' ? '🚚' : '⏳'} <b>${e.comprador || 'Sin nombre'}</b>\n   ${e.producto || '—'} | ${e.tracking ? `Tracking: ${e.tracking}` : 'Sin tracking'}`
        ).join('\n\n');
        await sendTelegram(chatId, `🚚 <b>Envíos activos (${envios.length})</b>\n⏳ Pendientes: ${pendientes.length} | 🚚 En camino: ${enCamino.length}\n\n${lineas}`);
      }
      return res.status(200).json({ ok: true });
    }

    if (textoLower.includes('ganancia')) {
      const now = new Date();
      const primeroDeMes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const [ventasRes, productosRes] = await Promise.all([
        supabase.from('ventas').select('*').gte('fecha', primeroDeMes),
        supabase.from('productos').select('sku, costo'),
      ]);
      const ventas = ventasRes.data || [];
      const costoMap = {};
      (productosRes.data || []).forEach(p => { costoMap[p.sku] = p.costo; });
      if (ventas.length === 0) {
        await sendTelegram(chatId, '💰 <b>Ganancia este mes</b>\n\nSin ventas registradas este mes.');
      } else {
        let ingresos = 0, comisiones = 0, costos = 0;
        ventas.forEach(v => { ingresos += v.total; comisiones += v.comision || 0; costos += (costoMap[v.sku] || 0) * v.cantidad; });
        const ganancia = ingresos - comisiones - costos;
        const margen = ingresos > 0 ? ((ganancia / ingresos) * 100).toFixed(1) : 0;
        await sendTelegram(chatId,
          `💰 <b>Ganancia estimada — este mes</b>\n\n📈 Ingresos: $${ingresos.toLocaleString('es-AR')}\n💸 Comisiones: -$${comisiones.toLocaleString('es-AR')}\n🏭 Costos: -$${costos.toLocaleString('es-AR')}\n─────────────────\n✅ <b>Ganancia: $${ganancia.toLocaleString('es-AR')}</b>\n📊 Margen: ${margen}%` +
          (costos === 0 ? '\n\n⚠️ <i>Costos en $0. Cargalos en cada producto para mayor precisión.</i>' : '')
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (textoLower.includes('recomendacion') || textoLower.includes('recomendación') || textoLower.includes('mejorar')) {
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
      const sinStock = productos.filter(p => p.stock_dep === 0);
      const stockBajo = productos.filter(p => p.stock_dep <= p.alerta_min);
      const porProducto = {};
      ventas.forEach(v => {
        if (!porProducto[v.producto]) porProducto[v.producto] = { total: 0, cant: 0 };
        porProducto[v.producto].total += v.total; porProducto[v.producto].cant += v.cantidad;
      });
      const topProductos = Object.entries(porProducto).sort((a, b) => b[1].total - a[1].total).slice(0, 5)
        .map(([n, d]) => `${n}: $${d.total} (${d.cant} uds)`);
      const sinVenta = productos.filter(p => !ventas.find(v => v.sku === p.sku)).map(p => p.nombre).slice(0, 5);
      const prompt = `Soy dueño de Martinez Motos, tienda de accesorios para motos en Uruguay. Vendemos por Mercado Libre y mostrador.\n\nDAtos del mes:\n- Ventas: ${ventas.length} (MELI: ${ventas.filter(v=>v.canal==='meli').length}, Mostrador: ${ventas.filter(v=>v.canal==='mostrador').length})\n- Ingresos: $${ventas.reduce((a,v)=>a+v.total,0).toLocaleString('es-AR')}\n- Envíos activos: ${envios.length}\n- Sin stock: ${sinStock.length}, Stock bajo: ${stockBajo.length}\n- Top productos: ${topProductos.join(', ')}\n- Sin ventas: ${sinVenta.join(', ') || 'ninguno'}\n\nDame 4-5 recomendaciones concretas y accionables. Cada una con emoji y máximo 2 líneas.`;
      const iaRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
      });
      const iaData = await iaRes.json();
      await sendTelegram(chatId, `🤖 <b>Recomendaciones para Martinez Motos</b>\n\n${iaData.content?.[0]?.text || 'No se pudo generar el análisis.'}`);
      return res.status(200).json({ ok: true });
    }

    // ── Texto libre → interpretar con IA ────────────────────
    if (process.env.ANTHROPIC_API_KEY) {
      const { data: productos } = await supabase.from('productos').select('sku, nombre, stock_dep, precio').order('nombre');
      const contexto = (productos || []).map(p => `SKU: ${p.sku} | Nombre: ${p.nombre} | Stock: ${p.stock_dep} | Precio: $${p.precio}`).join('\n');

      const accion = await interpretarMensaje(texto, contexto);

      if (accion.tipo === 'consulta' && accion.resumen === 'no_reconocido') {
        await sendTelegram(chatId, `❓ No entendí ese mensaje.\n\nEscribí <b>comandos</b> para ver qué puedo hacer.`);
        return res.status(200).json({ ok: true });
      }

      // Guardar acción y pedir confirmación
      await setPendiente(supabase, chatId, accion);
      await sendTelegram(chatId,
        `📋 <b>Confirmar acción</b>\n\n${accion.resumen}\n\nRespondé <b>si</b> para confirmar o <b>no</b> para cancelar.`
      );
    } else {
      await sendTelegram(chatId, MENU);
    }

  } catch (err) {
    console.error('Error en webhook Telegram:', err.message);
    await sendTelegram(chatId, '❌ Ocurrió un error. Revisá los logs de Vercel.');
  }

  return res.status(200).json({ ok: true });
};
