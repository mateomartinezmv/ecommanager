// api/_stockSync.js
// Un solo lugar desde donde se mueve el stock.
//
// Regla del sistema (ver _packs.js):
//   · stock_dep       → unidades sueltas reales del depósito.
//   · stock_meli      → lo que publica MELI    = packsDisponibles(stock_dep)
//   · stock_shopify   → lo que publica Shopify = packsDisponibles(stock_dep)
//
// Las tres columnas se quedan, pero stock_meli y stock_shopify no son números
// con vida propia: son el espejo de stock_dep. Cualquier movimiento —venta de
// mostrador, venta de MELI, venta de Shopify, devolución, importación, ajuste a
// mano— pasa por `sincronizarStock`, que recalcula el espejo y lo empuja a los
// dos canales. Antes cada endpoint hacía su propia cuenta y empujaba a MELI
// sólo a veces y a Shopify casi nunca, y por eso los canales publicaban stock
// que el depósito ya no tenía.
//
// Dos cosas de Shopify que conviene saber antes de tocar esto:
//
//   · La app NO tiene el scope `read_locations`: /locations.json devuelve 403.
//     La ubicación se averigua por /inventory_levels.json?inventory_item_ids=…,
//     que sí entra con `write_inventory`. Si alguien vuelve a poner locations.json
//     acá, el empuje a Shopify falla entero y en silencio.
//
//   · productos.shopify_id guarda el ID de VARIANTE, no el del producto. Un
//     producto con 5 colores son 5 variantes, y cada SKU del CRM es una de
//     ellas. Cuando falta, se resuelve por SKU y se guarda, así un producto
//     nuevo se enlaza solo la primera vez que se mueve su stock.

const { getMeliToken } = require('./_meliToken');
const { getShopifyToken } = require('./_shopifyToken');
const { meliIdsDe } = require('./_meliIds');
const { packsDisponibles } = require('./_packs');

const SHOPIFY_SHOP = 'martinez-motos.myshopify.com';
const SHOPIFY_API = `https://${SHOPIFY_SHOP}/admin/api/2024-01`;

// ───────────────────────────────── MELI ─────────────────────────────────

async function syncMeliStock(token, meliId, cantidad) {
  const meliRes = await fetch(`https://api.mercadolibre.com/items/${meliId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ available_quantity: cantidad }),
  });
  const meliData = await meliRes.json();
  if (meliData.error) throw new Error(meliData.message);
  return meliData;
}

// Empuja el mismo stock a TODAS las publicaciones del producto: cada
// publicación lleva su propio available_quantity y todas venden del mismo
// depósito. Un fallo en una no frena a las demás; se devuelven los errores.
async function syncMeliStockProducto(token, producto, cantidad) {
  const ids = meliIdsDe(producto);
  const sincronizadas = [];
  const errores = [];

  for (const meliId of ids) {
    try {
      await syncMeliStock(token, meliId, cantidad);
      sincronizadas.push(meliId);
    } catch (err) {
      errores.push({ meliId, error: err.message });
    }
  }

  return { sincronizadas, errores };
}

// ──────────────────────────────── Shopify ────────────────────────────────

async function shopifyFetch(token, path, opciones = {}) {
  const res = await fetch(`${SHOPIFY_API}${path}`, {
    ...opciones,
    headers: {
      'X-Shopify-Access-Token': token,
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opciones.headers || {}),
    },
  });
  const texto = await res.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto }; }
  if (!res.ok) throw new Error(data.error || data.errors ? JSON.stringify(data.error || data.errors) : `HTTP ${res.status}`);
  return data;
}

// `gid://shopify/ProductVariant/123` → `123`
function idNumerico(gid) {
  const m = String(gid || '').match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

// Busca la variante por SKU. Si hay más de una con el mismo SKU no adivina:
// enlazar la equivocada mandaría el stock de un producto al de otro.
async function variantePorSku(token, sku) {
  const data = await shopifyFetch(token, '/graphql.json', {
    method: 'POST',
    body: JSON.stringify({
      query: 'query($q:String!){ productVariants(first:3, query:$q){ edges{ node{ id sku inventoryItem{ id } } } } }',
      variables: { q: `sku:"${String(sku).replace(/"/g, '\\"')}"` },
    }),
  });
  if (data.errors) throw new Error(JSON.stringify(data.errors));

  const nodos = (data.data?.productVariants?.edges || [])
    .map(e => e.node)
    .filter(n => n?.sku === sku);

  if (!nodos.length) return null;
  if (nodos.length > 1) throw new Error(`Hay ${nodos.length} variantes en Shopify con el SKU ${sku}: enlazala a mano`);

  return {
    variantId: idNumerico(nodos[0].id),
    inventoryItemId: idNumerico(nodos[0].inventoryItem?.id),
  };
}

async function inventoryItemDeVariante(token, variantId) {
  const data = await shopifyFetch(token, `/variants/${variantId}.json`);
  const id = data.variant?.inventory_item_id;
  if (!id) throw new Error(`Variante ${variantId} sin inventory_item_id`);
  return String(id);
}

// La ubicación del depósito. No se puede pedir /locations.json (hace falta el
// scope read_locations, que la app no tiene): se lee del nivel de inventario
// del propio ítem, que es la misma para toda la tienda. Se cachea porque el
// lambda se reusa entre invocaciones.
let ubicacionCache = null;
async function ubicacionShopify(token, inventoryItemId) {
  if (ubicacionCache) return ubicacionCache;
  const data = await shopifyFetch(token, `/inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
  const locationId = data.inventory_levels?.[0]?.location_id;
  if (!locationId) throw new Error('No se encontró la ubicación de inventario en Shopify');
  ubicacionCache = String(locationId);
  return ubicacionCache;
}

// Deja la variante del producto en `cantidad`. Resuelve el shopify_id por SKU
// si falta y lo guarda, así el enlace se arregla solo.
// Devuelve { variantId, enlazado } o lanza con el motivo.
async function syncShopifyStockProducto(supabase, token, producto, cantidad) {
  let variantId = producto.shopify_id || null;
  let inventoryItemId = null;
  let enlazado = false;

  if (!variantId) {
    const v = await variantePorSku(token, producto.sku);
    if (!v) throw new Error(`El SKU ${producto.sku} no existe en Shopify`);
    variantId = v.variantId;
    inventoryItemId = v.inventoryItemId;
    enlazado = true;
    if (supabase) {
      await supabase.from('productos').update({ shopify_id: variantId }).eq('sku', producto.sku);
    }
  }

  if (!inventoryItemId) inventoryItemId = await inventoryItemDeVariante(token, variantId);
  const locationId = await ubicacionShopify(token, inventoryItemId);

  await shopifyFetch(token, '/inventory_levels/set.json', {
    method: 'POST',
    body: JSON.stringify({
      location_id: Number(locationId),
      inventory_item_id: Number(inventoryItemId),
      available: Math.max(0, Number(cantidad) || 0),
    }),
  });

  return { variantId, enlazado };
}

// ────────────────────────── Entrada única de stock ──────────────────────────

// Deja el depósito en `nuevoStockDep` y publica el espejo en MELI y en Shopify.
//
// No lanza: un canal caído no puede tumbar el alta de una venta ni el cierre de
// una devolución. Lo que falló vuelve en el reporte para que el llamador lo
// loguee o lo muestre.
//
// `producto` necesita: sku, unidades_por_venta, meli_id/meli_ids, shopify_id.
async function sincronizarStock(supabase, producto, nuevoStockDep) {
  const stockDep = Math.max(0, Number(nuevoStockDep) || 0);
  const stockPublicado = packsDisponibles(stockDep, producto);

  const reporte = {
    stockDep,
    stockPublicado,
    meli: { sincronizadas: [], errores: [] },
    shopify: { sincronizada: false, enlazado: false, error: null },
    error: null,
  };

  const { error: updErr } = await supabase.from('productos').update({
    stock_dep: stockDep,
    stock_meli: stockPublicado,
    stock_shopify: stockPublicado,
    updated_at: new Date().toISOString(),
  }).eq('sku', producto.sku);

  if (updErr) {
    // Si no se pudo guardar el depósito, empujar a los canales dejaría las
    // publicaciones contando algo que el CRM no respalda.
    reporte.error = updErr.message;
    return reporte;
  }

  if (meliIdsDe(producto).length) {
    try {
      const token = await getMeliToken();
      reporte.meli = await syncMeliStockProducto(token, producto, stockPublicado);
    } catch (err) {
      reporte.meli.errores.push({ meliId: null, error: err.message });
    }
  }

  try {
    const token = await getShopifyToken();
    const r = await syncShopifyStockProducto(supabase, token, producto, stockPublicado);
    reporte.shopify = { sincronizada: true, enlazado: r.enlazado, variantId: r.variantId, error: null };
  } catch (err) {
    reporte.shopify = { sincronizada: false, enlazado: false, error: err.message };
  }

  return reporte;
}

// Para loguear el resultado de una sincronización en una línea.
function resumenSync(sku, reporte) {
  const partes = [`${sku} → ${reporte.stockPublicado} (depósito ${reporte.stockDep})`];
  if (reporte.meli.sincronizadas.length) partes.push(`MELI ok: ${reporte.meli.sincronizadas.join(', ')}`);
  for (const e of reporte.meli.errores) partes.push(`MELI error${e.meliId ? ` (${e.meliId})` : ''}: ${e.error}`);
  if (reporte.shopify.sincronizada) partes.push(`Shopify ok${reporte.shopify.enlazado ? ' (enlazado por SKU)' : ''}`);
  else if (reporte.shopify.error) partes.push(`Shopify error: ${reporte.shopify.error}`);
  if (reporte.error) partes.push(`CRM error: ${reporte.error}`);
  return partes.join(' · ');
}

// ───────────────────────────── Importaciones ─────────────────────────────

// Cuántos SKU se sincronizan a la vez cuando llega una importación.
//
// Sincronizar un producto cuesta ~1,5 s (un PUT a cada publicación de MELI más
// el empuje a Shopify). De a uno, una importación de seis SKU ya rozaba los 10 s
// que Vercel le da a la función: la cortaba a mitad de camino, el navegador
// recibía un 504 y la pantalla mostraba "Error" aunque el estado y el stock ya
// estuvieran guardados. Peor todavía, los SKU que quedaban después del corte no
// sumaban su stock y no había forma de reintentarlo (la importación ya figuraba
// como recibida).
//
// De a cuatro, una importación de treinta SKU entra con margen. No se sube más
// para no castigar el rate limit de MELI ni el de Shopify, que es el más
// estrecho de los dos.
const SKUS_EN_PARALELO = 4;

// Corre `fn` sobre `items` de a `tamano` a la vez, respetando el orden de salida.
async function enLotes(items, tamano, fn) {
  const salidas = [];
  for (let i = 0; i < items.length; i += tamano) {
    salidas.push(...await Promise.all(items.slice(i, i + tamano).map(fn)));
  }
  return salidas;
}

// Suma stock_dep para cada ítem de una importación que acaba de llegar. Las
// cantidades vienen en unidades sueltas (así llegan las cajas del proveedor).
// No lanza por producto: acumula errores/no-encontrados para que un SKU con
// problemas no bloquee al resto.
async function applyImportArrival(supabase, items) {
  const aplicados = [];
  const noEncontrados = [];
  const errores = [];

  // Suma cantidades por SKU (por si el mismo SKU aparece en varios ítems)
  const qtyBySku = {};
  for (const it of (items || [])) {
    const sku = (it.sku || '').trim();
    const qty = Number(it.qty || it.quantity_ordered || 0);
    if (!sku || !qty) continue;
    qtyBySku[sku] = (qtyBySku[sku] || 0) + qty;
  }

  const skus = Object.keys(qtyBySku);
  if (!skus.length) return { aplicados, noEncontrados, errores };

  const { data: productos, error } = await supabase
    .from('productos')
    .select('sku, stock_dep, unidades_por_venta, meli_id, meli_ids, shopify_id')
    .in('sku', skus);
  if (error) throw error;

  const porSku = {};
  for (const p of (productos || [])) porSku[p.sku] = p;

  // `sincronizarStock` no lanza, así que el lote nunca se cae entero por un SKU.
  const resultados = await enLotes(skus, SKUS_EN_PARALELO, async sku => {
    const p = porSku[sku];
    if (!p) return { sku, p };

    const r = await sincronizarStock(supabase, p, (p.stock_dep || 0) + qtyBySku[sku]);
    console.log('📦 Importación:', resumenSync(sku, r));
    return { sku, p, r };
  });

  for (const { sku, p, r } of resultados) {
    if (!p) { noEncontrados.push(sku); continue; }
    if (r.error) { errores.push({ sku, error: r.error }); continue; }

    aplicados.push({ sku, sumado: qtyBySku[sku], nuevoStock: r.stockDep, nuevoStockPublicado: r.stockPublicado });
    for (const e of r.meli.errores) errores.push({ sku, error: `MELI${e.meliId ? ` ${e.meliId}` : ''}: ${e.error}` });
    if (r.shopify.error) errores.push({ sku, error: `Shopify: ${r.shopify.error}` });
  }

  return { aplicados, noEncontrados, errores };
}

module.exports = {
  applyImportArrival,
  sincronizarStock,
  resumenSync,
  syncMeliStock,
  syncMeliStockProducto,
  syncShopifyStockProducto,
  variantePorSku,
};
