#!/usr/bin/env node
// scripts/reprocesar-faltantes.js
//
// Diagnóstico y reprocesamiento de órdenes MELI faltantes.
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   MELI_CLIENT_ID=... MELI_CLIENT_SECRET=... \
//   node scripts/reprocesar-faltantes.js
//
// O bien con las credenciales en un archivo .env.local cargado con dotenv.

'use strict';

// ── Cargar variables de entorno desde .env.local si existe ──────────────────
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.+)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { createClient } = require('@supabase/supabase-js');

// ── Órdenes a investigar y reprocesar ───────────────────────────────────────
const ORDENES_FALTANTES = [
  { id: '2000012312202281', fecha: '2026-04-01 10:21', comprador: 'Roque J. Martiniano' },
  { id: '2000012280006297', fecha: '2026-03-30 12:47', comprador: 'dylan rodri' },
  { id: '2000012277970529', fecha: '2026-03-30 10:45', comprador: 'Giuliano Garcia' },
  { id: '2000012261247389', fecha: '2026-03-28 23:57', comprador: 'Nicolas Petre' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(msg); }
function sep() { console.log('─'.repeat(60)); }

function normalizarTexto(t) {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const ZONAS_KEYWORDS = {
  1: ['pajas blancas', 'santiago vazquez', 'paso de la arena', 'ciudad del plata'],
  2: ['la paz', 'colon', 'lezica', 'abayuba', 'jardines del hipodromo'],
  3: ['toledo', 'manga', 'piedras blancas', 'flor de maronas', 'maronas', 'ituzaingo'],
  4: ['barros blancos', 'pueblo nuevo', 'bolivar', 'las canteras'],
  5: ['pocitos', 'buceo', 'malvin', 'punta carretas', 'parque rodo', 'palermo', 'cordon', 'tres cruces', 'villa espanola', 'union'],
  6: ['punta gorda', 'carrasco', 'shangrila', 'neptunia', 'el pinar'],
  7: ['ciudad vieja', 'centro', 'goes', 'la comercial', 'aguada', 'reducto', 'belvedere', 'la blanqueada', 'figurita', 'jacinto vera', 'sayago', 'nuevo paris', 'cerro', 'la teja', 'paso molino', 'penarol'],
  8: ['progreso', 'las piedras', 'sauce', 'empalme olmos', 'juanico'],
  9: ['pando', 'toledo este', 'lagomar', 'solymar', 'la floresta'],
  10: ['ciudad de la costa', 'atlantida', 'parque del plata', 'salinas', 'costa'],
  11: ['canelones ciudad', 'canelones capital', '14 de julio'],
};

function detectarZona(dir) {
  if (!dir) return null;
  const d = normalizarTexto(dir);
  for (const [zona, kws] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of kws) { if (d.includes(normalizarTexto(kw))) return parseInt(zona); }
  }
  return null;
}

// ── Token MELI ───────────────────────────────────────────────────────────────
async function getMeliToken(supabase) {
  const { data, error } = await supabase.from('meli_tokens').select('*').eq('id', 1).single();
  if (error || !data) throw new Error('MELI no conectado: ' + (error?.message || 'sin datos'));

  const now = new Date();
  const expiresAt = new Date(data.expires_at);
  if (expiresAt - now < 5 * 60 * 1000) {
    log('🔄 Token próximo a vencer, refrescando...');
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.MELI_CLIENT_ID,
        client_secret: process.env.MELI_CLIENT_SECRET,
        refresh_token: data.refresh_token,
      }),
    });
    const nt = await r.json();
    if (nt.error) throw new Error('No se pudo refrescar token: ' + nt.message);
    const newExpiry = new Date(Date.now() + nt.expires_in * 1000).toISOString();
    await supabase.from('meli_tokens').update({
      access_token: nt.access_token,
      refresh_token: nt.refresh_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    return nt.access_token;
  }
  return data.access_token;
}

// ── Procesar una orden completa ──────────────────────────────────────────────
async function procesarOrden(orderId, supabase, token) {
  const itemLog = [];

  // 1) Obtener orden desde MELI
  itemLog.push(`  → GET /orders/${orderId}`);
  const r = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const order = await r.json();
  if (order.error) {
    itemLog.push(`  ❌ API error: ${order.message} (${order.error})`);
    return { ok: false, log: itemLog, ventasCreadas: [] };
  }
  itemLog.push(`  Estado: ${order.status} | Items: ${order.order_items?.length} | Comprador: ${order.buyer?.nickname}`);

  if (order.status !== 'paid') {
    itemLog.push(`  ⏭ Orden no pagada (estado: ${order.status}) — se omite`);
    return { ok: false, log: itemLog, ventasCreadas: [] };
  }

  // 2) Obtener shipment
  const shippingId = order.shipping?.id;
  let logisticType = '', direccion = null, costoEnvioReal = 0;
  if (shippingId) {
    try {
      const sr = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const sd = await sr.json();
      logisticType = sd?.logistic_type || '';
      costoEnvioReal = sd?.shipping_option?.list_cost || sd?.base_cost || 0;
      if (sd?.receiver_address) {
        const addr = sd.receiver_address;
        direccion = `${addr.street_name} ${addr.street_number}, ${addr.city?.name}, ${addr.state?.name}`;
      }
      itemLog.push(`  Envío: logistic_type="${logisticType}" | dirección: ${direccion || 'N/D'}`);
    } catch (_) {
      itemLog.push('  ⚠ No se pudo leer shipment, usando fallback mercado_envios');
    }
  } else {
    itemLog.push('  Sin shipping_id (retiro en punto)');
  }

  const esFlex = logisticType === 'fulfillment' || logisticType === 'self_service';
  const transportista = esFlex ? 'gestionpost' : 'mercado_envios';
  const costoEnvioFinal = esFlex ? costoEnvioReal : 0;

  // 3) Comisión global
  const feeDetails = order.fee_details || [];
  const totalFee = feeDetails
    .filter(f => f.type === 'mercadopago_fee' || f.type === 'ml_fee')
    .reduce((s, f) => s + Math.abs(f.amount || 0), 0);
  const hasFeeDetails = totalFee > 0;
  const orderTotalCalc = (order.order_items || []).reduce((s, i) => s + i.unit_price * i.quantity, 0) || 1;
  itemLog.push(`  Comisión total fee_details: $${totalFee} (${hasFeeDetails ? 'desde API' : 'fallback sale_fee'})`);

  const ventasCreadas = [];

  // 4) Procesar cada item
  for (const item of order.order_items || []) {
    const meliItemId = item.item?.id;
    const cantidad = item.quantity || 1;
    const precioUnit = item.unit_price || 0;
    const ventaId = `V_MELI_${order.id}_${meliItemId}`;

    itemLog.push(`\n  [Item ${meliItemId}] x${cantidad} a $${precioUnit}`);

    // Chequear si ya existe
    const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single();
    if (ventaExistente) {
      itemLog.push(`  ℹ Venta ${ventaId} ya existe — omitida`);
      ventasCreadas.push({ ventaId, estado: 'ya_existe' });
      continue;
    }

    // Buscar producto por meli_id
    let { data: producto } = await supabase.from('productos').select('*').eq('meli_id', meliItemId).single();

    // Si no existe, auto-crear (bug original: el webhook no hacía esto)
    if (!producto) {
      itemLog.push(`  ⚠ meli_id=${meliItemId} no encontrado en productos — auto-creando...`);
      const skuAuto = `MELI-${meliItemId}`;
      let nombreItem = item.item?.title || `Producto MELI ${meliItemId}`;
      try {
        const ir = await fetch(`https://api.mercadolibre.com/items/${meliItemId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const id = await ir.json();
        if (!id.error) nombreItem = id.title;
      } catch (_) {}

      const { data: existeEnDb } = await supabase.from('productos').select('sku').eq('sku', skuAuto).single();
      if (!existeEnDb) {
        const { error: insertErr } = await supabase.from('productos').insert({
          sku: skuAuto,
          nombre: nombreItem,
          stock_dep: 0,
          stock_meli: 0,
          costo: 0,
          precio: precioUnit,
          alerta_min: 3,
          meli_id: meliItemId,
          notas: 'Auto-creado por reprocesamiento manual',
        });
        if (insertErr) {
          itemLog.push(`  ❌ Error auto-creando producto: ${insertErr.message}`);
          ventasCreadas.push({ ventaId, estado: 'error', error: insertErr.message });
          continue;
        }
        itemLog.push(`  ✅ Producto auto-creado: ${skuAuto} — "${nombreItem}"`);
      }
      // Recargar
      const { data: p2 } = await supabase.from('productos').select('*').eq('sku', skuAuto).single();
      producto = p2;
    }

    if (!producto) {
      itemLog.push('  ❌ No se pudo obtener/crear producto');
      ventasCreadas.push({ ventaId, estado: 'error', error: 'producto nulo' });
      continue;
    }

    // Descontar stock
    const nuevoStock = Math.max(0, producto.stock_dep - cantidad);
    await supabase.from('productos').update({
      stock_dep: nuevoStock,
      stock_meli: nuevoStock,
      updated_at: new Date().toISOString(),
    }).eq('sku', producto.sku);
    itemLog.push(`  Stock actualizado: ${producto.stock_dep} → ${nuevoStock}`);

    // Calcular comisión
    const comisionItem = hasFeeDetails
      ? Math.round((totalFee * (precioUnit * cantidad) / orderTotalCalc) * 100) / 100
      : Math.abs(item.sale_fee || 0);

    // Insertar venta
    const { error: ventaErr } = await supabase.from('ventas').insert({
      id: ventaId,
      canal: 'meli',
      fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      orden_meli: String(order.id),
      comprador: order.buyer?.nickname || '',
      sku: producto.sku,
      producto: producto.nombre,
      cantidad,
      precio_unit: precioUnit,
      comision: comisionItem,
      total: precioUnit * cantidad,
      estado: 'pagada',
      genera_envio: !!shippingId,
      notas: 'Reprocesada manualmente (script diagnóstico)',
    });
    if (ventaErr) {
      itemLog.push(`  ❌ Error insertando venta: ${ventaErr.message}`);
      ventasCreadas.push({ ventaId, estado: 'error', error: ventaErr.message });
      continue;
    }
    itemLog.push(`  ✅ Venta creada: ${ventaId} | comisión $${comisionItem} | ${transportista}`);

    // Auto-vincular cliente por meli_nickname
    const buyerNick = order.buyer?.nickname;
    if (buyerNick) {
      const { data: cliente } = await supabase.from('clientes').select('id').eq('meli_nickname', buyerNick).single();
      if (cliente) {
        await supabase.from('ventas').update({ cliente_id: cliente.id }).eq('id', ventaId);
        itemLog.push(`  🔗 Cliente vinculado: id=${cliente.id}`);
      }
    }

    // Insertar envío
    if (shippingId) {
      const envioId = `E_MELI_${order.id}_${meliItemId}`;
      const { data: envioExistente } = await supabase.from('envios').select('id').eq('id', envioId).single();
      if (!envioExistente) {
        const zona = detectarZona(direccion);
        await supabase.from('envios').insert({
          id: envioId,
          venta_id: ventaId,
          orden: String(order.id),
          comprador: order.buyer?.nickname || '',
          producto: producto.nombre,
          transportista,
          tracking: null,
          fecha_despacho: null,
          estado: 'pendiente',
          direccion: direccion || null,
          costo: costoEnvioFinal,
          ...(zona ? { zona } : {}),
        });
        itemLog.push(`  ✅ Envío creado: ${envioId} | ${transportista} $${costoEnvioFinal} | zona ${zona || 'N/D'}`);
      } else {
        itemLog.push(`  ℹ Envío ${envioId} ya existe`);
      }
    }

    ventasCreadas.push({ ventaId, estado: 'creada', sku: producto.sku, comision: comisionItem, transportista });
  }

  return { ok: true, log: itemLog, ventasCreadas };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   EcomManager — Reprocesamiento de Órdenes MELI Faltantes  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Validar env vars
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'MELI_CLIENT_ID', 'MELI_CLIENT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('❌ Faltan variables de entorno:', missing.join(', '));
    console.error('   Exportalas o creá un archivo .env.local en la raíz del proyecto.');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  let token;
  try {
    token = await getMeliToken(supabase);
    log('✅ Token MELI OK');
  } catch (e) {
    console.error('❌ Error obteniendo token:', e.message);
    process.exit(1);
  }

  // Verificar usuario MELI
  const meRes = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const me = await meRes.json();
  if (me.error) {
    console.error('❌ Token inválido:', me.message);
    process.exit(1);
  }
  log(`✅ Usuario MELI: ${me.nickname} (${me.id})`);
  log('');

  // ── FASE 1: Diagnóstico — verificar cuáles existen en la DB ────────────────
  log('━━━ FASE 1: Diagnóstico ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');

  const resumen = [];
  for (const o of ORDENES_FALTANTES) {
    const ventaPattern = `V_MELI_${o.id}_%`;
    const { data: ventas } = await supabase
      .from('ventas')
      .select('id, sku, producto, fecha, estado, notas')
      .like('id', ventaPattern);

    const { data: notifLogs } = await supabase
      .from('meli_notify_log')
      .select('*')
      .or(`resource.like.%${o.id}%,topic.not.is.null`)
      .limit(5);

    const estadoDB = ventas?.length > 0 ? `✅ EXISTE (${ventas.length} venta/s)` : '❌ NO EXISTE en DB';
    log(`Orden #${o.id}`);
    log(`  Fecha: ${o.fecha} | Comprador: ${o.comprador}`);
    log(`  Estado DB: ${estadoDB}`);
    if (ventas?.length > 0) {
      for (const v of ventas) log(`    → ${v.id} | ${v.sku} | ${v.estado} | notas: ${v.notas || '—'}`);
    }
    log('');
    resumen.push({ ...o, enDB: ventas?.length > 0, ventas: ventas || [] });
  }

  // ── FASE 2: Verificar meli_notify_log ─────────────────────────────────────
  log('━━━ FASE 2: Audit log de webhooks ━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');

  const { data: ultimosLogs } = await supabase
    .from('meli_notify_log')
    .select('*')
    .order('recibido_at', { ascending: false })
    .limit(20);

  if (!ultimosLogs || ultimosLogs.length === 0) {
    log('⚠ meli_notify_log está VACÍO — el webhook nunca escribió en esta tabla.');
    log('  → Esto confirma que no hay forma de auditar qué notificaciones llegaron.');
  } else {
    log(`Últimas ${ultimosLogs.length} entradas en meli_notify_log:`);
    for (const l of ultimosLogs) {
      log(`  ${l.recibido_at} | topic: ${l.topic} | resource: ${l.resource}`);
    }
  }
  log('');

  // ── FASE 3: Reprocesar las faltantes ──────────────────────────────────────
  const faltantes = resumen.filter(o => !o.enDB);
  log(`━━━ FASE 3: Reprocesando ${faltantes.length} orden/es faltante/s ━━━━━━━━━━`);
  log('');

  if (faltantes.length === 0) {
    log('✅ Todas las órdenes ya están en la base de datos. Nada que reprocesar.');
  }

  for (const o of faltantes) {
    sep();
    log(`\n🔄 Reprocesando orden #${o.id} (${o.comprador})`);
    const result = await procesarOrden(o.id, supabase, token);
    for (const l of result.log) log(l);
    if (result.ventasCreadas.length > 0) {
      log(`\n  Resumen: ${result.ventasCreadas.length} item/s procesado/s`);
      for (const v of result.ventasCreadas) {
        log(`    ${v.estado === 'creada' ? '✅' : v.estado === 'ya_existe' ? 'ℹ' : '❌'} ${v.ventaId} — ${v.estado}`);
      }
    }
    log('');
  }

  // ── RESUMEN FINAL ─────────────────────────────────────────────────────────
  sep();
  log('\n📋 RESUMEN FINAL\n');
  for (const o of resumen) {
    const fueReprocesada = faltantes.find(f => f.id === o.id);
    log(`  #${o.id} (${o.comprador})`);
    if (o.enDB) {
      log(`    Estado: ya estaba en DB`);
    } else if (fueReprocesada) {
      log(`    Estado: reprocesada en esta ejecución`);
    }
  }

  log('\n🔎 CAUSA RAÍZ IDENTIFICADA:');
  log('  1. notify.js silenciaba órdenes cuando meli_id no estaba en productos');
  log('     (hacía `continue` sin crear registro ni fallback).');
  log('  2. notify.js nunca escribía en meli_notify_log, imposibilitando auditoría.');
  log('  3. sync-meli-orders usaba limit=50 sin paginación — órdenes antiguas se perdían.');
  log('\n  → Los fixes están en api/meli/notify.js y supabase/functions/sync-meli-orders/index.ts');
  log('');
}

main().catch(e => {
  console.error('❌ Error fatal:', e.message);
  process.exit(1);
});
