// api/shopify/notify.js
// POST /api/shopify/notify                      → webhooks de pedidos de Shopify
//                                                  (orders/create, orders/paid, orders/updated, orders/cancelled)
// GET  /api/shopify/notify?orden=ID             → reprocesar manualmente una orden
// GET  /api/shopify/notify?accion=sincronizar   → traer los pedidos de los últimos días (&dias=N, por defecto 3)
// GET  /api/shopify/notify?accion=webhooks      → dar de alta en Shopify los webhooks que falten
//
// Antes sólo se escuchaba orders/paid, así que un pedido pagado por transferencia o en
// efectivo (que entra como "Pago pendiente") nunca llegaba al CRM. Ahora la venta se
// registra apenas se crea el pedido —Shopify ya reservó la mercadería, así que el stock
// se baja en ese momento— y queda "pendiente" hasta que se cobra. Con el pedido se cargan
// también el cliente (con su teléfono) y el envío (con la dirección), para poder imprimir
// la etiqueta igual que en mostrador.
//
// Todo es idempotente: el mismo pedido puede llegar por varios webhooks a la vez, por un
// reintento o por la sincronización periódica, y sólo la primera vez mueve stock.

const { getSupabase } = require('../_supabase');
const { descontarStock, sincronizarStock, resumenSync } = require('../_stockSync');
const { getShopifyToken } = require('../_shopifyToken');
const { unidadesDeDeposito } = require('../_packs');
const { detectarZona, COSTOS_ENVIOSUY } = require('../_flexZonas');

const SHOP = 'martinez-motos.myshopify.com';
const API = `https://${SHOP}/admin/api/2024-01`;
const TOPICOS_WEBHOOK = ['orders/create', 'orders/paid', 'orders/updated', 'orders/cancelled'];

// El estado de la venta sale del estado de cobro de Shopify.
function estadoDeOrden(order) {
  if (order.cancelled_at) return 'cancelada';
  switch (order.financial_status) {
    case 'paid':
    case 'partially_refunded':
      return 'pagada';
    case 'refunded':
    case 'voided':
      return 'cancelada';
    default: // pending, authorized, partially_paid
      return 'pendiente';
  }
}

// Mismos valores que el selector de método de pago de mostrador.
function metodoPagoDeOrden(order) {
  const gw = (order.payment_gateway_names || []).join(' ').toLowerCase();
  if (!gw) return null;
  if (/transfer/.test(gw)) return 'transferencia';
  if (/efectivo|cash|contra ?entrega|cod\b/.test(gw)) return 'efectivo';
  if (/mercado ?pago|qr/.test(gw)) return 'qr';
  return gw.slice(0, 40);
}

// Lo que se cobra de la línea: precio de lista menos los descuentos que Shopify le
// asignó (cupones como CONTADO10). El envío va aparte.
function importesDeLinea(item) {
  const precio = parseFloat(item.price) || 0;
  const cantidad = Number(item.quantity) || 0;
  const bruto = precio * cantidad;
  const descuento = (item.discount_allocations || [])
    .reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  return {
    precio,
    cantidad,
    descuentoMonto: Math.round(descuento * 100) / 100,
    descuentoPct: bruto > 0 ? Math.round((descuento / bruto) * 1000) / 10 : 0,
    total: Math.round((bruto - descuento) * 100) / 100,
  };
}

function nombreDeOrden(order) {
  const c = order.customer || {};
  const s = order.shipping_address || {};
  const b = order.billing_address || {};
  return (`${c.first_name || ''} ${c.last_name || ''}`.trim()
    || s.name || b.name || order.email || '').trim();
}

function telefonoDeOrden(order) {
  return (order.shipping_address?.phone || order.customer?.phone || order.phone
    || order.billing_address?.phone || '').trim();
}

// "Defensa 1827, Apto 201, Montevideo". Cada parte una sola vez.
function direccionDeOrden(order) {
  const s = order.shipping_address;
  if (!s) return null;
  const partes = [s.address1, s.address2, s.city, s.province && s.province !== s.city ? s.province : null]
    .map(p => (p || '').trim()).filter(Boolean);
  const vistas = new Set();
  return partes.filter(p => { const k = p.toLowerCase(); if (vistas.has(k)) return false; vistas.add(k); return true; }).join(', ') || null;
}

// Retiro en local: no hay paquete que despachar.
function esRetiro(order) {
  const lineas = order.shipping_lines || [];
  if (!order.shipping_address || !lineas.length) return true;
  return lineas.every(l => /retiro|pick ?up|recoger|local/i.test(`${l.title || ''} ${l.code || ''}`));
}

function esDuplicado(err) {
  return err && (err.code === '23505' || /duplicate key/i.test(err.message || ''));
}

// Ficha del cliente: de ahí sale el teléfono de la etiqueta. Se reusa la que ya exista
// (por el id de cliente de Shopify, el teléfono o el email) y se le completa lo que falte.
async function asegurarCliente(supabase, order, log) {
  const nombre = nombreDeOrden(order);
  if (!nombre) return null;
  const telefono = telefonoDeOrden(order) || null;
  const email = (order.customer?.email || order.email || '').trim() || null;
  const idShopify = order.customer?.id ? `CLI_SHOP_${order.customer.id}` : null;

  let cliente = null;
  if (idShopify) ({ data: cliente } = await supabase.from('clientes').select('*').eq('id', idShopify).maybeSingle());
  if (!cliente && telefono) ({ data: cliente } = await supabase.from('clientes').select('*').eq('telefono', telefono).limit(1).maybeSingle());
  if (!cliente && email) ({ data: cliente } = await supabase.from('clientes').select('*').eq('email', email).limit(1).maybeSingle());

  if (cliente) {
    const cambios = {};
    if (!cliente.telefono && telefono) cambios.telefono = telefono;
    if (!cliente.email && email) cambios.email = email;
    if (Object.keys(cambios).length) {
      cambios.updated_at = new Date().toISOString();
      await supabase.from('clientes').update(cambios).eq('id', cliente.id);
    }
    return cliente.id;
  }

  const nuevo = {
    id: idShopify || 'CLI' + Date.now(),
    nombre,
    telefono,
    email,
    canal_origen: 'shopify',
  };
  const { error } = await supabase.from('clientes').insert(nuevo);
  if (error && !esDuplicado(error)) {
    if (log) log.push(`⚠️ No se pudo crear el cliente: ${error.message}`);
    return null;
  }
  if (log) log.push(`✅ Cliente: ${nombre}${telefono ? ` (${telefono})` : ''}`);
  return nuevo.id;
}

async function buscarProducto(supabase, item) {
  if (item.variant_id) {
    const { data } = await supabase.from('productos').select('*').eq('shopify_id', String(item.variant_id)).maybeSingle();
    if (data) return data;
  }
  if (item.sku) {
    const { data } = await supabase.from('productos').select('*').eq('sku', item.sku).maybeSingle();
    if (data) return data;
  }
  return null;
}

// El pedido se canceló en Shopify: la mercadería vuelve al depósito una sola vez y el
// envío que todavía no salió se borra.
async function cancelarOrden(supabase, order, log) {
  const { data: ventas } = await supabase.from('ventas').select('*').like('id', `V_SHOP_${order.id}_%`);
  const resultados = [];
  for (const venta of ventas || []) {
    if (venta.estado === 'cancelada') {
      resultados.push({ ventaId: venta.id, estado: 'ya_cancelada' });
      continue;
    }
    const { data: producto } = await supabase.from('productos').select('*').eq('sku', venta.sku).maybeSingle();
    await supabase.from('ventas').update({ estado: 'cancelada' }).eq('id', venta.id);
    if (producto) {
      const sync = await sincronizarStock(supabase, producto, producto.stock_dep + unidadesDeDeposito(venta.cantidad, producto));
      if (log) log.push(`🔄 Cancelada ${venta.id}: ${resumenSync(venta.sku, sync)}`);
    }
    resultados.push({ ventaId: venta.id, estado: 'cancelada' });
  }
  await supabase.from('envios').delete().eq('id', `E_SHOP_${order.id}`).eq('estado', 'pendiente');
  return resultados;
}

async function crearEnvio(supabase, order, lineas, log) {
  if (!lineas.length || esRetiro(order)) return null;
  const direccion = direccionDeOrden(order);
  const zona = detectarZona([direccion, order.shipping_address?.zip].filter(Boolean).join(', '));
  const envio = {
    id: `E_SHOP_${order.id}`,
    venta_id: lineas[0].id,
    orden: order.name || String(order.order_number || order.id),
    comprador: (order.shipping_address?.name || nombreDeOrden(order) || '').trim() || null,
    producto: lineas.length === 1 ? lineas[0].producto : lineas.map(v => `${v.producto} x${v.cantidad}`).join(' + '),
    // Lo mismo que propone el formulario de envío de mostrador: EnviosUy, con el costo
    // de la zona si se reconoce el barrio. Se corrige desde Envíos si va por otro lado.
    transportista: 'enviosuy',
    estado: 'pendiente',
    direccion,
    zona,
    costo: zona ? (COSTOS_ENVIOSUY[zona] ?? 0) : 0,
    colecta: false,
  };
  const { error } = await supabase.from('envios').insert(envio);
  if (error) {
    if (esDuplicado(error)) return envio.id;
    if (log) log.push(`⚠️ No se pudo crear el envío: ${error.message}`);
    return null;
  }
  if (log) log.push(`🚚 Envío ${envio.id} → ${direccion || 'sin dirección'}${zona ? ` (zona ${zona})` : ''}`);
  return envio.id;
}

async function procesarOrden(order, supabase, log) {
  const estado = estadoDeOrden(order);
  if (estado === 'cancelada') return cancelarOrden(supabase, order, log);

  const metodoPago = metodoPagoDeOrden(order);
  const fecha = order.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const items = (order.line_items || []).filter(i => (Number(i.quantity) || 0) > 0);
  // Un pedido con varios productos es un carrito: se ve y se cuenta como una sola venta.
  const ventaGrupo = items.length > 1 ? `SHOP_${order.id}` : null;
  let clienteId;

  const resultados = [];
  const lineas = [];
  for (const item of items) {
    const variantId = String(item.variant_id);
    const ventaId = `V_SHOP_${order.id}_${variantId}`;
    if (log) log.push(`Item: variant ${variantId}, x${item.quantity}, $${item.price}`);

    const { data: existente } = await supabase.from('ventas').select('*').eq('id', ventaId).maybeSingle();
    if (existente) {
      // Ya registrada (llegó por otro webhook o por la sincronización): lo único que puede
      // cambiar es que se haya cobrado. El stock no se toca de nuevo, y un estado que se
      // cambió a mano en el CRM no se pisa.
      lineas.push(existente);
      if (existente.estado === 'pendiente' && estado === 'pagada') {
        await supabase.from('ventas').update({ estado, ...(metodoPago ? { metodo_pago: metodoPago } : {}) }).eq('id', ventaId);
        if (log) log.push(`✅ ${ventaId}: ${existente.estado} → ${estado}`);
        resultados.push({ variant: variantId, estado: 'actualizada', ventaId });
      } else {
        if (log) log.push(`ℹ️ Venta ${ventaId} ya existe`);
        resultados.push({ variant: variantId, estado: 'ya_existe', ventaId });
      }
      continue;
    }

    // Si se canceló a mano desde el CRM (🗑️), la sincronización no la tiene que revivir.
    const { data: cancelada } = await supabase.from('ventas_canceladas').select('venta_id').eq('venta_id', ventaId).limit(1).maybeSingle();
    if (cancelada) {
      if (log) log.push(`ℹ️ Venta ${ventaId} cancelada a mano en el CRM: no se vuelve a registrar`);
      resultados.push({ variant: variantId, estado: 'cancelada_en_crm', ventaId });
      continue;
    }

    const producto = await buscarProducto(supabase, item);
    if (!producto) {
      const msg = `⚠️ Variante ${variantId}${item.sku ? ` (SKU ${item.sku})` : ''} no encontrada en CRM`;
      console.log(msg);
      if (log) log.push(msg);
      resultados.push({ variant: variantId, error: 'Producto no encontrado' });
      continue;
    }
    if (log) log.push(`✅ Producto: ${producto.sku} - ${producto.nombre}`);

    if (clienteId === undefined) clienteId = await asegurarCliente(supabase, order, log);

    const imp = importesDeLinea(item);
    const venta = {
      id: ventaId,
      canal: 'shopify',
      fecha,
      venta_grupo: ventaGrupo,
      orden_meli: null,
      comprador: nombreDeOrden(order),
      cliente: nombreDeOrden(order) || null,
      cliente_id: clienteId || null,
      sku: producto.sku,
      producto: producto.nombre,
      cantidad: imp.cantidad,
      precio_unit: imp.precio,
      comision: 0,
      descuento_pct: imp.descuentoPct,
      descuento_monto: imp.descuentoMonto,
      total: imp.total,
      estado,
      metodo_pago: metodoPago,
      genera_envio: !esRetiro(order),
      notas: `Shopify ${order.name || ''}`.trim(),
    };

    // La venta se inserta ANTES de mover el stock: si dos webhooks del mismo pedido
    // llegan juntos, el id repetido frena al segundo y el depósito baja una sola vez.
    const { error: ventaErr } = await supabase.from('ventas').insert(venta);
    if (ventaErr) {
      if (esDuplicado(ventaErr)) {
        lineas.push(venta);
        resultados.push({ variant: variantId, estado: 'ya_existe', ventaId });
        continue;
      }
      throw ventaErr;
    }
    lineas.push(venta);
    console.log(`✅ Venta Shopify registrada: ${order.name || order.id}, ${producto.nombre} x${imp.cantidad} (${estado})`);
    if (log) log.push(`✅ Venta registrada: ${ventaId} (${estado})`);

    // `cantidad` viene en unidades vendidas (packs); el depósito se lleva
    // unidades_por_venta unidades por cada una. Shopify ya se descontó lo suyo, pero con
    // packs su cuenta no coincide con la nuestra, así que igual se le fija el valor.
    // La resta es atómica: otro pedido del mismo SKU procesándose a la vez no la pisa.
    const sync = await descontarStock(supabase, producto, unidadesDeDeposito(imp.cantidad, producto));
    const linea = resumenSync(producto.sku, sync);
    console.log('📉 Venta Shopify:', linea);
    if (log) log.push(linea);

    resultados.push({ variant: variantId, estado: 'registrada', ventaId, sku: producto.sku });
  }

  // El envío se arma sólo cuando el pedido entra por primera vez: si después se borra a
  // mano (por ejemplo, porque al final lo retiró en el local) no vuelve a aparecer.
  if (resultados.some(r => r.estado === 'registrada')) {
    const envioId = await crearEnvio(supabase, order, lineas, log);
    if (envioId) resultados.push({ envio: envioId });
  }
  return resultados;
}

async function shopifyFetch(token, path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(body.errors || body).slice(0, 200)}`);
  return body;
}

// Red de contención de los webhooks: trae los pedidos de los últimos días y procesa los
// que falten. La usan el botón de la pestaña Shopify y el cron de cada 30 minutos.
async function sincronizarPedidosShopify({ dias = 3 } = {}) {
  const token = await getShopifyToken();
  const supabase = getSupabase();
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const { orders = [] } = await shopifyFetch(token,
    `/orders.json?status=any&limit=100&created_at_min=${encodeURIComponent(desde)}`);

  const r = { revisados: orders.length, nuevos: 0, actualizados: 0, errores: 0, log: [] };
  for (const order of orders) {
    try {
      const res = await procesarOrden(order, supabase, null);
      const nuevos = res.filter(x => x.estado === 'registrada').length;
      const act = res.filter(x => x.estado === 'actualizada' || x.estado === 'cancelada').length;
      r.nuevos += nuevos;
      r.actualizados += act;
      if (nuevos || act) r.log.push(`${order.name}: ${nuevos} nueva(s), ${act} actualizada(s)`);
      for (const x of res.filter(x => x.error)) r.log.push(`${order.name}: ⚠️ ${x.error} (variante ${x.variant})`);
    } catch (err) {
      r.errores++;
      r.log.push(`${order.name}: ❌ ${err.message}`);
    }
  }
  return r;
}

async function asegurarWebhooks(direccion) {
  const token = await getShopifyToken();
  const { webhooks = [] } = await shopifyFetch(token, '/webhooks.json?limit=250');
  const resultado = [];
  for (const topic of TOPICOS_WEBHOOK) {
    const ya = webhooks.find(w => w.topic === topic && w.address === direccion);
    if (ya) { resultado.push({ topic, estado: 'ya_estaba' }); continue; }
    try {
      await shopifyFetch(token, '/webhooks.json', {
        method: 'POST',
        body: JSON.stringify({ webhook: { topic, address: direccion, format: 'json' } }),
      });
      resultado.push({ topic, estado: 'creado' });
    } catch (err) {
      resultado.push({ topic, estado: 'error', error: err.message });
    }
  }
  return { direccion, webhooks: resultado, otros: webhooks.filter(w => w.address !== direccion).map(w => ({ topic: w.topic, address: w.address })) };
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    const log = [];
    try {
      if (req.query.accion === 'sincronizar') {
        const dias = Math.min(60, Math.max(1, parseInt(req.query.dias) || 3));
        const r = await sincronizarPedidosShopify({ dias });
        return res.json({ ok: true, ...r });
      }

      if (req.query.accion === 'webhooks') {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const r = await asegurarWebhooks(`https://${host}/api/shopify/notify`);
        return res.json({ ok: true, ...r });
      }

      // ?orden=ID → reprocesar manualmente
      const orderId = req.query.orden;
      if (!orderId) return res.status(400).json({ error: 'Falta ?orden=ORDER_ID o ?accion=sincronizar' });
      const token = await getShopifyToken();
      log.push('✅ Token Shopify OK');
      const { order } = await shopifyFetch(token, `/orders/${encodeURIComponent(orderId)}.json`);
      log.push(`✅ Orden ${order.name}, ${order.line_items.length} item(s), cobro: ${order.financial_status}`);
      const resultados = await procesarOrden(order, getSupabase(), log);
      return res.json({ ok: true, log, resultados });
    } catch (err) {
      log.push(`❌ ${err.message}`);
      return res.status(500).json({ ok: false, log, error: err.message });
    }
  }

  // POST → webhook de Shopify
  if (req.method === 'POST') {
    try {
      let order = req.body;
      if (Buffer.isBuffer(order)) { try { order = JSON.parse(order.toString()); } catch (_) {} }
      if (typeof order === 'string') { try { order = JSON.parse(order); } catch (_) {} }
      if (!order || !order.line_items) {
        console.warn('⚠️ shopify/notify: body vacío o sin line_items', typeof order);
        return res.status(200).json({ ok: true });
      }
      console.log(`🛍️ Webhook ${req.headers['x-shopify-topic'] || '?'}: ${order.name || order.id} (${order.financial_status})`);
      await procesarOrden(order, getSupabase(), null);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Error en /api/shopify/notify:', err.message);
      return res.status(200).json({ ok: true }); // Siempre 200: la sincronización periódica lo levanta
    }
  }

  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.procesarOrden = procesarOrden;
module.exports.sincronizarPedidosShopify = sincronizarPedidosShopify;
module.exports.estadoDeOrden = estadoDeOrden;
module.exports.importesDeLinea = importesDeLinea;
module.exports.direccionDeOrden = direccionDeOrden;
