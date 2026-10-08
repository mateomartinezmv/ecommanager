#!/usr/bin/env node
// scripts/fotos/reemplazar-fotos.js
//
// Reemplaza las fotos de un producto en MELI (en TODAS sus publicaciones, o sea en todos
// sus ángulos de venta) y en Shopify (sólo en la variante del producto, no en los otros
// colores). La primera foto de la carpeta es la portada.
//
// Uso:
//   node scripts/fotos/reemplazar-fotos.js --sku HP-Q0211                 # simulacro (no toca nada)
//   node scripts/fotos/reemplazar-fotos.js --sku HP-Q0211 --aplicar       # escribe de verdad
//   ... --solo-meli | --solo-shopify                                      # una plataforma sola
//   ... --portada-producto                                               # ver AVISO de abajo
//   ... --borrar 5001,5006                                               # fotos viejas de Shopify a borrar
//
// Credenciales: las mismas que usa la app (en .env.local o en el entorno):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, MELI_CLIENT_ID, MELI_CLIENT_SECRET,
//   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
//
// Por defecto NO aplica nada: imprime el estado actual y el plan, para poder mirarlo antes.
//
// AVISO sobre Shopify: los tres colores (Negro/Azul/Rojo) son variantes de UN solo producto
// y comparten UNA sola galería. Shopify no reparte la galería por color: cada variante apunta
// a UNA única foto suya (variant.image_id) y todo el resto de la galería se le muestra igual a
// quien mire cualquier color. O sea que "las fotos de la variante Negro" no existen como
// conjunto: existe la foto de la variante y existe la galería común.
//
// Por eso acá:
//   · se suben las 5 fotos nuevas a la galería del producto,
//   · se pone la foto 1 como foto de la variante del SKU,
//   · se borra la foto que era la de esa variante (eso es el reemplazo),
//   · NO se borra nada más por las nuestras: la API no dice de qué color es cada foto de la
//     galería, así que las que no están asignadas a ninguna variante se listan y se borran
//     sólo si se pasan a mano con --borrar 123,456.
// Las fotos de los otros colores no se tocan nunca. Si además se quiere que la foto 1 pase a
// ser la portada del producto entero (la miniatura del catálogo, común a los tres colores),
// hay que pasar --portada-producto a propósito.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Cargar variables de entorno desde .env.local si existe ──────────────────
const envFile = path.join(__dirname, '..', '..', '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.+)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { getSupabase } = require('../../api/_supabase');
const { getMeliToken } = require('../../api/_meliToken');
const { getShopifyToken } = require('../../api/_shopifyToken');
const { meliIdsDe } = require('../../api/_meliIds');

const API_ML = 'https://api.mercadolibre.com';
const SHOP = process.env.SHOPIFY_SHOP || 'martinez-motos.myshopify.com';
const API_SHOPIFY = `https://${SHOP}/admin/api/2024-10`;

// ── Argumentos ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opcion(nombre, porDefecto = null) {
  const i = argv.indexOf(nombre);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : porDefecto;
}
const SKU = opcion('--sku', 'HP-Q0211');
const CARPETA = opcion('--fotos', path.join(__dirname, SKU));
const APLICAR = argv.includes('--aplicar');
const SOLO_MELI = argv.includes('--solo-meli');
const SOLO_SHOPIFY = argv.includes('--solo-shopify');
const PORTADA_PRODUCTO = argv.includes('--portada-producto');
const BORRAR = (opcion('--borrar', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ── Salida ───────────────────────────────────────────────────────────────────
const log = (m = '') => console.log(m);
const sep = () => log('─'.repeat(74));
const titulo = (m) => { log(); sep(); log(m); sep(); };
const avisos = [];
const aviso = (m) => { avisos.push(m); log(`  ⚠️  ${m}`); };

// ── Fotos de la carpeta, en orden (la primera es la portada) ────────────────
function leerFotos() {
  if (!fs.existsSync(CARPETA)) throw new Error(`No existe la carpeta de fotos: ${CARPETA}`);
  const archivos = fs.readdirSync(CARPETA)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort();                                   // el prefijo 01-, 02-… define el orden
  if (!archivos.length) throw new Error(`No hay fotos .jpg/.png en ${CARPETA}`);
  return archivos.map((nombre) => ({
    nombre,
    ruta: path.join(CARPETA, nombre),
    bytes: fs.readFileSync(path.join(CARPETA, nombre)),
  }));
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function pedir(url, opciones = {}) {
  const res = await fetch(url, opciones);
  const texto = await res.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto }; }
  return { ok: res.ok, status: res.status, data };
}

async function ml(token, ruta, opciones = {}) {
  return pedir(`${API_ML}${ruta}`, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opciones.body && typeof opciones.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(opciones.headers || {}),
    },
  });
}

async function shopify(token, ruta, opciones = {}) {
  return pedir(`${API_SHOPIFY}${ruta}`, {
    ...opciones,
    headers: {
      'X-Shopify-Access-Token': token,
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opciones.headers || {}),
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// MELI
// ═════════════════════════════════════════════════════════════════════════════

// Sube una foto a la cuenta y devuelve su picture_id. El id sirve para cualquier
// publicación del vendedor, así que se sube una sola vez y se reusa en los tres ángulos.
async function subirFotoMeli(token, foto) {
  const form = new FormData();
  const tipo = /\.png$/i.test(foto.nombre) ? 'image/png' : 'image/jpeg';
  form.append('file', new Blob([foto.bytes], { type: tipo }), foto.nombre);

  const { ok, status, data } = await ml(token, '/pictures/items/upload', { method: 'POST', body: form });
  if (!ok || !data.id) {
    throw new Error(`MELI rechazó la foto ${foto.nombre} (HTTP ${status}): ${JSON.stringify(data)}`);
  }
  return data.id;
}

// El color de la variación, para no tocar las de los otros colores.
function colorDeVariacion(variacion) {
  const atributos = variacion.attribute_combinations || [];
  const color = atributos.find((a) => /COLOR/i.test(a.id || '') || /color/i.test(a.name || ''));
  return (color?.value_name || '').trim();
}

async function actualizarItem(token, itemId, nuevosIds, colorBuscado) {
  log(`\n▸ ${itemId}`);
  const { ok, status, data: item } = await ml(token, `/items/${itemId}`);
  if (!ok) { aviso(`${itemId}: no se pudo leer (HTTP ${status}). Se saltea.`); return false; }

  log(`  título: ${item.title}`);
  log(`  estado: ${item.status} · vendidas: ${item.sold_quantity} · variaciones: ${(item.variations || []).length}`);
  log(`  fotos actuales (${(item.pictures || []).length}):`);
  for (const [i, p] of (item.pictures || []).entries()) log(`     ${i + 1}. ${p.id}  ${p.secure_url || p.url}`);

  if (item.status === 'closed') { aviso(`${itemId}: está cerrada. Se saltea.`); return false; }
  if (item.catalog_listing) {
    aviso(`${itemId}: es publicación de catálogo — MELI usa las fotos de la ficha de catálogo y no deja cambiarlas desde acá. Se saltea.`);
    return false;
  }

  let cuerpo;
  const variaciones = item.variations || [];

  if (!variaciones.length) {
    // Publicación de un solo color: se reemplaza la galería entera.
    cuerpo = { pictures: nuevosIds.map((id) => ({ id })) };
    log(`  → se reemplazan las ${(item.pictures || []).length} fotos por las ${nuevosIds.length} nuevas`);
  } else {
    // Publicación con variaciones: sólo la del color pedido.
    const objetivo = variaciones.filter((v) => colorDeVariacion(v).toLowerCase() === colorBuscado.toLowerCase());
    if (objetivo.length !== 1) {
      aviso(`${itemId}: tiene ${variaciones.length} variaciones y ${objetivo.length} coinciden con "${colorBuscado}" ` +
            `(${variaciones.map(colorDeVariacion).join(', ')}). No se adivina: se saltea.`);
      return false;
    }
    const variacion = objetivo[0];
    const idsDeOtras = new Set(
      variaciones.filter((v) => v.id !== variacion.id).flatMap((v) => v.picture_ids || [])
    );
    // La galería del ítem tiene que contener todas las fotos de todas las variaciones.
    const galeria = [...nuevosIds, ...[...idsDeOtras].filter((id) => !nuevosIds.includes(id))];
    cuerpo = {
      pictures: galeria.map((id) => ({ id })),
      variations: variaciones.map((v) => ({
        id: v.id,
        picture_ids: v.id === variacion.id ? nuevosIds : (v.picture_ids || []),
      })),
    };
    log(`  → variación "${colorDeVariacion(variacion)}" (${variacion.id}): ${(variacion.picture_ids || []).length} fotos → ${nuevosIds.length} nuevas`);
    log(`  → se conservan ${idsDeOtras.size} fotos de las otras variaciones`);
  }

  if (!APLICAR) { log('  (simulacro: no se escribió nada)'); return true; }

  const r = await ml(token, `/items/${itemId}`, { method: 'PUT', body: JSON.stringify(cuerpo) });
  if (!r.ok) { aviso(`${itemId}: MELI rechazó el cambio (HTTP ${r.status}): ${JSON.stringify(r.data)}`); return false; }

  const verif = await ml(token, `/items/${itemId}?attributes=pictures`);
  const quedaron = (verif.data?.pictures || []).map((p) => p.id);
  const portadaOk = quedaron[0] === nuevosIds[0];
  log(`  ✅ quedó con ${quedaron.length} fotos · portada ${portadaOk ? 'correcta' : 'DISTINTA: ' + quedaron[0]}`);
  if (!portadaOk) aviso(`${itemId}: la portada no quedó en la foto 1.`);
  return true;
}

async function haceloEnMeli(producto, fotos) {
  titulo(`MERCADO LIBRE — ${producto.sku} · ${producto.nombre}`);
  const ids = meliIdsDe(producto);
  log(`Publicaciones (ángulos de venta): ${ids.join(', ')}`);

  const token = await getMeliToken();

  let nuevosIds;
  if (APLICAR) {
    log('\nSubiendo fotos a MELI…');
    nuevosIds = [];
    for (const foto of fotos) {
      const id = await subirFotoMeli(token, foto);
      nuevosIds.push(id);
      log(`  ${foto.nombre} → ${id}`);
    }
  } else {
    nuevosIds = fotos.map((f, i) => `«id-que-daría-MELI-${i + 1}»`);
    log('\n(simulacro: no se suben fotos)');
  }

  // El color sale del nombre del producto en el CRM ("… - Negro").
  const color = (producto.nombre.split('-').pop() || '').trim();
  log(`Color de este SKU: ${color}`);

  let hechas = 0;
  for (const id of ids) if (await actualizarItem(token, id, nuevosIds, color)) hechas++;
  log(`\nMELI: ${hechas}/${ids.length} publicaciones ${APLICAR ? 'actualizadas' : 'listas para actualizar'}.`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SHOPIFY
// ═════════════════════════════════════════════════════════════════════════════

async function haceloEnShopify(producto, fotos) {
  titulo(`SHOPIFY — ${producto.sku}`);
  const variantId = String(producto.shopify_id || '').trim();
  if (!variantId) { aviso('El producto no tiene shopify_id cargado. Se saltea Shopify.'); return; }

  const token = await getShopifyToken();

  const v = await shopify(token, `/variants/${variantId}.json`);
  if (!v.ok || !v.data.variant) { aviso(`No se pudo leer la variante ${variantId} (HTTP ${v.status}). Se saltea Shopify.`); return; }
  const variante = v.data.variant;
  const productId = variante.product_id;

  const p = await shopify(token, `/products/${productId}.json`);
  if (!p.ok || !p.data.product) { aviso(`No se pudo leer el producto ${productId} (HTTP ${p.status}). Se saltea Shopify.`); return; }
  const prod = p.data.product;

  log(`Producto: ${prod.title} (${productId})`);
  log(`Variante del SKU: "${variante.title}" (${variantId}) · sku=${variante.sku}`);
  log(`Variantes del producto: ${prod.variants.map((x) => `${x.title}/${x.sku}`).join(' · ')}`);
  log(`\nGalería actual (${prod.images.length} fotos) — "de" dice a qué variantes está asignada:`);
  for (const img of prod.images) {
    const de = img.variant_ids.length
      ? img.variant_ids.map((id) => prod.variants.find((x) => x.id === id)?.title || id).join('+')
      : 'ninguna (común)';
    const marca = String(img.id) === String(variante.image_id) ? ' ← foto actual de la variante' : '';
    log(`  pos ${String(img.position).padEnd(2)} id=${img.id}  de=${de}${marca}`);
  }

  // En Shopify una variante apunta a UNA sola foto. Esa es la única que la API da por
  // "de este color", y por lo tanto la única que se puede reemplazar sin adivinar.
  const fotoDeLaVariante = prod.images.find((i) => String(i.id) === String(variante.image_id)) || null;
  const otrasVariantes = prod.variants.filter((x) => String(x.id) !== variantId);
  const deOtrosColores = new Set(otrasVariantes.map((x) => String(x.image_id)).filter(Boolean));
  const sinDuenio = prod.images.filter(
    (i) => String(i.id) !== String(variante.image_id) && !deOtrosColores.has(String(i.id))
  );

  const aBorrar = [];
  if (fotoDeLaVariante) aBorrar.push(fotoDeLaVariante);
  for (const id of BORRAR) {
    const img = prod.images.find((i) => String(i.id) === id);
    if (!img) { aviso(`--borrar ${id}: no existe esa foto en el producto. Se ignora.`); continue; }
    if (deOtrosColores.has(String(img.id))) { aviso(`--borrar ${id}: es la foto de otro color. NO se borra.`); continue; }
    if (!aBorrar.includes(img)) aBorrar.push(img);
  }

  log(`\n→ se suben ${fotos.length} fotos nuevas a la galería del producto`);
  log(`→ la foto 1 (${fotos[0].nombre}) queda como foto de la variante "${variante.title}"`);
  log(`→ se borra(n) ${aBorrar.length} foto(s) vieja(s): ${aBorrar.map((i) => `${i.id} (pos ${i.position})`).join(', ') || '—'}`);
  log(`→ NO se tocan las fotos de los otros colores: ${[...deOtrosColores].join(', ') || '—'}`);
  if (sinDuenio.length) {
    aviso(`Quedan ${sinDuenio.length} foto(s) de la galería que la API no atribuye a ningún color ` +
          `(${sinDuenio.map((i) => `${i.id}@pos${i.position}`).join(', ')}). Si alguna es vieja de este SKU, ` +
          `pasala con --borrar; a ciegas no se borra.`);
  }
  log(PORTADA_PRODUCTO
    ? '→ --portada-producto: además la foto 1 pasa a posición 1 del producto (afecta la miniatura común a los 3 colores)'
    : '→ la portada del PRODUCTO (posición 1, común a los 3 colores) no se toca. Para cambiarla: --portada-producto');

  if (!APLICAR) { log('\n(simulacro: no se escribió nada)'); return; }

  // Subir primero, borrar después: si algo falla, el producto nunca queda sin fotos.
  // Sin variant_ids: si se las asignara a la variante, Shopify se las iría sacando a la
  // anterior y quedaría asignada sólo la última.
  const nuevas = [];
  for (const foto of fotos) {
    const r = await shopify(token, `/products/${productId}/images.json`, {
      method: 'POST',
      body: JSON.stringify({
        image: {
          attachment: foto.bytes.toString('base64'),
          filename: `${producto.sku}-${foto.nombre}`,
          alt: `${prod.title} ${variante.title}`,
        },
      }),
    });
    if (!r.ok || !r.data.image) throw new Error(`Shopify rechazó ${foto.nombre} (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
    nuevas.push(r.data.image);
    log(`  subida ${foto.nombre} → id=${r.data.image.id} pos=${r.data.image.position}`);
  }

  const rv = await shopify(token, `/variants/${variantId}.json`, {
    method: 'PUT',
    body: JSON.stringify({ variant: { id: Number(variantId), image_id: nuevas[0].id } }),
  });
  if (!rv.ok) aviso(`No se pudo fijar la foto 1 como foto de la variante (HTTP ${rv.status}): ${JSON.stringify(rv.data)}`);
  else log(`  foto de la variante "${variante.title}" = ${nuevas[0].id} (${fotos[0].nombre})`);

  if (PORTADA_PRODUCTO) {
    const r = await shopify(token, `/products/${productId}/images/${nuevas[0].id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ image: { id: nuevas[0].id, position: 1 } }),
    });
    if (!r.ok) aviso(`No se pudo mover la foto 1 a la portada del producto (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
    else log('  foto 1 movida a la portada del producto');
  }

  for (const img of aBorrar) {
    const r = await shopify(token, `/products/${productId}/images/${img.id}.json`, { method: 'DELETE' });
    if (!r.ok) aviso(`No se pudo borrar la foto vieja ${img.id} (HTTP ${r.status}).`);
    else log(`  borrada foto vieja ${img.id}`);
  }

  const verif = await shopify(token, `/products/${productId}.json`);
  const final = verif.data?.product;
  const varFinal = final?.variants.find((x) => String(x.id) === variantId);
  log(`\n✅ Shopify: la galería quedó con ${final?.images.length} fotos.`);
  log(`   foto de "${variante.title}" = ${varFinal?.image_id} ${String(varFinal?.image_id) === String(nuevas[0].id) ? '(la foto 1 ✔)' : '(¡NO es la foto 1!)'}`);
  for (const antes of otrasVariantes) {
    const despues = final?.variants.find((y) => String(y.id) === String(antes.id));
    const sigue = String(despues?.image_id) === String(antes.image_id);
    if (sigue) log(`   ${antes.title}: foto ${despues?.image_id} sin cambios ✔`);
    else aviso(`La foto del color ${antes.title} cambió sola: ${antes.image_id} → ${despues?.image_id}. Revisalo.`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  const fotos = leerFotos();

  titulo(`${APLICAR ? 'APLICANDO' : 'SIMULACRO (no escribe nada — agregá --aplicar)'} · SKU ${SKU}`);
  log(`Fotos a publicar, en orden (la 1 es la portada), desde ${CARPETA}:`);
  for (const [i, f] of fotos.entries()) log(`  ${i + 1}. ${f.nombre} (${Math.round(f.bytes.length / 1024)} KB)`);

  const supabase = getSupabase();
  const { data: producto, error } = await supabase
    .from('productos')
    .select('sku, nombre, meli_id, meli_ids, shopify_id')
    .eq('sku', SKU)
    .single();
  if (error || !producto) throw new Error(`No se encontró el producto ${SKU} en el CRM: ${error?.message || ''}`);

  if (!SOLO_SHOPIFY) await haceloEnMeli(producto, fotos);
  if (!SOLO_MELI) await haceloEnShopify(producto, fotos);

  titulo('RESUMEN');
  if (avisos.length) { log('Cosas para mirar:'); for (const a of avisos) log(`  ⚠️  ${a}`); }
  else log('Sin avisos.');
  if (!APLICAR) log('\nFue un simulacro. Para escribir de verdad: agregá --aplicar');
}

main().catch((e) => { console.error(`\n❌ ${e.message}`); process.exit(1); });
