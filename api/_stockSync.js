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
const { relacionesDeKit, kitsQueUsan, productosPorSku, stockKit } = require('./_kits');

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
// `producto` necesita: sku, stock_dep, unidades_por_venta, meli_id/meli_ids, shopify_id.
//
// Kits (ver _kits.js): un kit no tiene depósito propio, así que `nuevoStockDep` se lee como
// "kits de más o de menos" respecto de producto.stock_dep (una devolución de 1 kit llega como
// stock_dep + 1) y esa diferencia se aplica a cada pieza. Después se empujan las piezas, el kit
// y los demás kits que comparten esas piezas. Si lo que se movió es una pieza suelta, se
// empujan además los kits que la usan.
async function sincronizarStock(supabase, producto, nuevoStockDep) {
  const rel = await relacionesDeKit(supabase, producto.sku);

  if (!rel.piezas.length) {
    const reporte = await sincronizarProducto(supabase, producto, nuevoStockDep);
    if (!reporte.error) reporte.kits = await publicarKits(supabase, rel.kits);
    return reporte;
  }

  const delta = Math.round((Number(nuevoStockDep) || 0) - (Number(producto.stock_dep) || 0));
  const piezas = await productosPorSku(supabase, rel.piezas.map(p => p.sku));
  const reportePiezas = [];

  if (delta) {
    for (const { sku, cantidad } of rel.piezas) {
      const pieza = piezas.get(sku);
      if (!pieza) {
        reportePiezas.push({ ...reporteVacio({ sku }, 0), sku, error: `Pieza ${sku} no encontrada` });
        continue;
      }
      const r = await sincronizarProducto(supabase, pieza, (Number(pieza.stock_dep) || 0) + delta * cantidad);
      reportePiezas.push({ ...r, sku });
    }
  }

  return publicarKitMovido(supabase, producto, rel, reportePiezas);
}

// Lo de siempre para un producto común: deja el depósito en `nuevoStockDep` y publica el
// espejo en MELI y en Shopify. No mira kits.
async function sincronizarProducto(supabase, producto, nuevoStockDep) {
  const reporte = reporteVacio(producto, nuevoStockDep);

  const { error: updErr } = await supabase.from('productos').update({
    stock_dep: reporte.stockDep,
    stock_meli: reporte.stockPublicado,
    stock_shopify: reporte.stockPublicado,
    updated_at: new Date().toISOString(),
  }).eq('sku', producto.sku);

  if (updErr) {
    // Si no se pudo guardar el depósito, empujar a los canales dejaría las
    // publicaciones contando algo que el CRM no respalda.
    reporte.error = updErr.message;
    return reporte;
  }

  return publicarStock(supabase, producto, reporte);
}

// Resta `unidades` del depósito por una venta y publica el espejo.
//
// La resta la hace Postgres (función descontar_stock) en vez de leer el stock,
// restar acá y escribir el resultado: MELI manda varios avisos de la misma
// orden en el mismo segundo, y con leer-restar-escribir cada uno descontaba
// sobre el valor que ya había bajado el anterior. Además de esto, quien llama
// tiene que haber registrado la venta ANTES, y descontar sólo si fue él quien
// la insertó (ver ventaNueva).
//
// Con un kit, la base descuenta las piezas (p_unidades kits × cantidad de cada una) y
// devuelve los kits que quedan; acá se empujan las publicaciones sueltas de las piezas y los
// demás kits que las usan, porque MELI sólo bajó la publicación que vendió.
async function descontarStock(supabase, producto, unidades) {
  const rel = await relacionesDeKit(supabase, producto.sku);

  const { data, error } = await supabase.rpc('descontar_stock', {
    p_sku: producto.sku,
    p_unidades: Math.max(0, Number(unidades) || 0),
  });
  if (error || data === null || data === undefined) {
    const reporte = reporteVacio(producto, producto.stock_dep);
    reporte.error = error?.message || `SKU ${producto.sku} no encontrado al descontar`;
    return reporte;
  }

  if (!rel.piezas.length) {
    const reporte = await publicarStock(supabase, producto, reporteVacio(producto, data));
    reporte.kits = await publicarKits(supabase, rel.kits);
    return reporte;
  }

  // Las piezas ya bajaron en la base: se releen y se publican tal cual quedaron.
  const piezas = await productosPorSku(supabase, rel.piezas.map(p => p.sku));
  const reportePiezas = [];
  for (const { sku } of rel.piezas) {
    const pieza = piezas.get(sku);
    if (!pieza) continue;
    reportePiezas.push({ ...(await publicarStock(supabase, pieza, reporteVacio(pieza, pieza.stock_dep))), sku });
  }
  return publicarKitMovido(supabase, { ...producto, stock_dep: data }, rel, reportePiezas);
}

// ─────────────────────────────────── Kits ───────────────────────────────────

// Después de mover las piezas de un kit: publica el kit con lo que quedó y los demás kits que
// comparten alguna de esas piezas. El número del kit lo deja la base (trigger); si no se puede
// releer, se calcula con las piezas.
async function publicarKitMovido(supabase, kit, rel, reportePiezas) {
  const skusPiezas = rel.piezas.map(p => p.sku);
  const [frescos, piezas, vecinos] = await Promise.all([
    productosPorSku(supabase, [kit.sku]),
    productosPorSku(supabase, skusPiezas),
    kitsQueUsan(supabase, skusPiezas),
  ]);

  const kitFresco = frescos.get(kit.sku) || kit;
  const calculado = stockKit(rel.piezas.map(p => ({ cantidad: p.cantidad, stock_dep: piezas.get(p.sku)?.stock_dep })));
  const stockDep = frescos.has(kit.sku) ? kitFresco.stock_dep : calculado;

  const reporte = await publicarStock(supabase, kitFresco, reporteVacio(kitFresco, stockDep), { esKit: true });
  reporte.piezas = reportePiezas;
  reporte.kits = await publicarKits(supabase, vecinos.filter(sku => sku !== kit.sku));
  const fallida = reportePiezas.find(r => r.error);
  if (fallida) reporte.error = `Pieza ${fallida.sku}: ${fallida.error}`;
  return reporte;
}

// Empuja a MELI el stock de estos kits tal como lo dejó la base. No lanza.
async function publicarKits(supabase, kitSkus) {
  const lista = [...new Set((kitSkus || []).filter(Boolean))];
  if (!lista.length) return [];
  const kits = await productosPorSku(supabase, lista);
  const reportes = [];
  for (const sku of lista) {
    const kit = kits.get(sku);
    if (!kit) continue;
    reportes.push({ ...(await publicarStock(supabase, kit, reporteVacio(kit, kit.stock_dep), { esKit: true })), sku });
  }
  return reportes;
}

// Inserta la venta y dice si este llamado fue el que la creó. Es lo que hace
// que una orden descuente stock una sola vez: si otro aviso de la misma orden
// ya la insertó, la clave primaria rechaza ésta (23505) y no se descuenta.
// Devuelve { nueva: true } | { nueva: false } | { error }.
async function ventaNueva(supabase, venta) {
  const { error } = await supabase.from('ventas').insert(venta);
  if (!error) return { nueva: true };
  if (error.code === '23505') return { nueva: false };
  return { error };
}

function reporteVacio(producto, stockDep) {
  const dep = Math.max(0, Number(stockDep) || 0);
  return {
    stockDep: dep,
    stockPublicado: packsDisponibles(dep, producto),
    meli: { sincronizadas: [], errores: [] },
    shopify: { sincronizada: false, enlazado: false, error: null },
    error: null,
  };
}

// Empuja reporte.stockPublicado a MELI y a Shopify. No lanza.
//
// Los kits se venden sólo en MELI: si no tienen variante de Shopify enlazada no se la busca
// por SKU (no existe, y cada movimiento dejaría un error en el log).
async function publicarStock(supabase, producto, reporte, { esKit = false } = {}) {
  const stockPublicado = reporte.stockPublicado;

  if (meliIdsDe(producto).length) {
    try {
      const token = await getMeliToken();
      reporte.meli = await syncMeliStockProducto(token, producto, stockPublicado);
    } catch (err) {
      reporte.meli.errores.push({ meliId: null, error: err.message });
    }
  }

  if (esKit && !producto.shopify_id) return reporte;

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
  // Lo que se movió de rebote: las piezas de un kit vendido y los kits que usan la pieza.
  for (const r of reporte.piezas || []) partes.push(`pieza ${resumenCorto(r)}`);
  for (const r of reporte.kits || []) partes.push(`kit ${resumenCorto(r)}`);
  return partes.join(' · ');
}

function resumenCorto(r) {
  const errores = [...(r.meli?.errores || []).map(e => `MELI ${e.meliId || ''} ${e.error}`.trim()), r.error].filter(Boolean);
  return `${r.sku} → ${r.stockPublicado}${errores.length ? ` (error: ${errores.join('; ')})` : ''}`;
}

// ───────────────────────────── Importaciones ─────────────────────────────

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

  for (const sku of skus) {
    const qty = qtyBySku[sku];
    const p = porSku[sku];
    if (!p) { noEncontrados.push(sku); continue; }

    const r = await sincronizarStock(supabase, p, (p.stock_dep || 0) + qty);
    console.log('📦 Importación:', resumenSync(sku, r));

    if (r.error) { errores.push({ sku, error: r.error }); continue; }

    aplicados.push({ sku, sumado: qty, nuevoStock: r.stockDep, nuevoStockPublicado: r.stockPublicado });
    for (const e of r.meli.errores) errores.push({ sku, error: `MELI${e.meliId ? ` ${e.meliId}` : ''}: ${e.error}` });
    if (r.shopify.error) errores.push({ sku, error: `Shopify: ${r.shopify.error}` });
  }

  return { aplicados, noEncontrados, errores };
}

module.exports = {
  applyImportArrival,
  descontarStock,
  sincronizarStock,
  ventaNueva,
  resumenSync,
  shopifyFetch,
  syncMeliStock,
  syncMeliStockProducto,
  syncShopifyStockProducto,
  variantePorSku,
};
