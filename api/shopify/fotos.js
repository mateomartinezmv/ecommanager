// api/shopify/fotos.js
// GET  /api/shopify/fotos              → qué fotos de MELI le faltan a cada producto de la tienda
// POST /api/shopify/fotos              → las sube, en todos los productos enlazados
// POST /api/shopify/fotos { sku }      → sólo al producto de ese SKU
// GET  /api/shopify/fotos?accion=subir[&sku=X] → lo mismo que el POST, para lanzarlo desde el navegador
//
// Las fotos se toman de la publicación principal de MELI (meli_ids[0]) y se agregan al final
// del producto de Shopify, en el orden de MELI. Nada se borra: lo que ya está en la tienda se
// queda, y una foto de MELI que ya estaba cargada no se vuelve a subir (ver _fotos.js).
//
// Shopify descarga cada foto desde el CDN de MELI en el momento del alta, así que cada una
// tarda: una pasada sobre todo el catálogo puede no entrar en los 60s de la función. Se sube
// lo que entre y se avisa cuántas quedaron; volver a llamar sigue desde ahí, porque lo ya
// subido deja de figurar como faltante.

const { getMeliToken } = require('../_meliToken');
const { getShopifyToken } = require('../_shopifyToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet } = require('../_meliPublicaciones');
const { shopifyFetch } = require('../_stockSync');
const { fotosDe } = require('../meli/_fotos');
const { armarPlan } = require('./_fotos');

const LOTE_MELI = 20;     // multiget de MELI
const LOTE_SHOPIFY = 50;  // nodes() de GraphQL
const TOPE_MS = 50000;    // la función se corta a los 60s (vercel.json)

// La publicación principal de cada producto con sus fotos. Si la principal no tiene fotos
// legibles, la primera de sus publicaciones que sí tenga.
async function originales(token, productos) {
  const ids = [...new Set(productos.flatMap(meliIdsDe))];
  const mapa = {};
  for (let i = 0; i < ids.length; i += LOTE_MELI) {
    const lote = ids.slice(i, i + LOTE_MELI);
    try {
      const data = await meliGet(token, `/items?ids=${lote.join(',')}&attributes=id,title,status,pictures`);
      for (const e of data || []) {
        if (e.code === 200 && e.body?.id) {
          mapa[e.body.id] = { meli_id: e.body.id, titulo: e.body.title || null, estado: e.body.status || null, fotos: fotosDe(e.body) };
        }
      }
    } catch (err) {
      console.error('originales:', err.message);
    }
  }
  const resultado = {};
  for (const p of productos) {
    const leidas = meliIdsDe(p).map(id => mapa[id]).filter(Boolean);
    resultado[p.sku] = leidas.find(x => x.fotos.length) || null;
  }
  return resultado;
}

// Producto e imágenes de cada variante enlazada, por GraphQL de a 50.
async function productosShopify(token, variantIds) {
  const mapa = {};
  for (let i = 0; i < variantIds.length; i += LOTE_SHOPIFY) {
    const lote = variantIds.slice(i, i + LOTE_SHOPIFY);
    const data = await shopifyFetch(token, '/graphql.json', {
      method: 'POST',
      body: JSON.stringify({
        query: `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant {
          id product { id title images(first:100){ edges{ node{ url } } } } } } }`,
        variables: { ids: lote.map(id => `gid://shopify/ProductVariant/${id}`) },
      }),
    });
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    for (const n of data.data?.nodes || []) {
      if (!n?.product) continue;
      mapa[n.id.split('/').pop()] = {
        productId: n.product.id.split('/').pop(),
        titulo: n.product.title,
        imagenes: (n.product.images?.edges || []).map(e => e.node.url),
      };
    }
  }
  return mapa;
}

async function planificar(supabase, skuFiltro = '') {
  const { data, error } = await supabase
    .from('productos')
    .select('sku, nombre, meli_id, meli_ids, shopify_id')
    .not('shopify_id', 'is', null)
    .order('nombre');
  if (error) throw error;

  const productos = (data || [])
    .filter(p => meliIdsDe(p).length)
    .filter(p => !skuFiltro || p.sku === skuFiltro);

  const [meliToken, shopifyToken] = await Promise.all([getMeliToken(), getShopifyToken()]);
  const [orig, shopify] = await Promise.all([
    originales(meliToken, productos),
    productosShopify(shopifyToken, [...new Set(productos.map(p => String(p.shopify_id)))]),
  ]);

  const plan = armarPlan(
    productos.map(p => ({ sku: p.sku, nombre: p.nombre, variantId: String(p.shopify_id), original: orig[p.sku] })),
    shopify
  );
  return { ...plan, shopifyToken };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabase = getSupabase();
    const skuFiltro = String(req.body?.sku || req.query?.sku || '').trim();
    const { productos, sinResolver, shopifyToken } = await planificar(supabase, skuFiltro);

    const resumen = (filas) => filas.map(f => ({
      productId: f.productId, titulo: f.titulo, skus: f.skus, meli_ids: f.meli_ids,
      en_shopify: f.imagenes.length, faltan: f.faltan.map(x => x.url),
    }));

    const subir = req.method === 'POST' || (req.method === 'GET' && req.query?.accion === 'subir');

    if (req.method === 'GET' && !subir) {
      return res.json({
        ok: true,
        resumen: {
          productos: productos.length,
          con_faltantes: productos.filter(f => f.faltan.length).length,
          fotos_faltantes: productos.reduce((s, f) => s + f.faltan.length, 0),
          sin_resolver: sinResolver.length,
        },
        productos: resumen(productos),
        sinResolver,
      });
    }

    if (!subir) return res.status(405).json({ ok: false, error: 'Method not allowed' });
    if (skuFiltro && !productos.length && !sinResolver.length) {
      return res.status(404).json({ ok: false, error: `${skuFiltro} no está enlazado a MELI y a Shopify.` });
    }

    // No corta ante un fallo: una foto que Shopify no pudo bajar no deja sin fotos al resto.
    const inicio = Date.now();
    const resultados = [];
    let pendientes = 0;
    for (const fila of productos) {
      for (const foto of fila.faltan) {
        if (Date.now() - inicio > TOPE_MS) { pendientes++; continue; }
        try {
          await shopifyFetch(shopifyToken, `/products/${fila.productId}/images.json`, {
            method: 'POST',
            body: JSON.stringify({ image: { src: foto.url } }),
          });
          resultados.push({ productId: fila.productId, titulo: fila.titulo, url: foto.url, ok: true });
        } catch (err) {
          resultados.push({ productId: fila.productId, titulo: fila.titulo, url: foto.url, ok: false, error: err.message });
        }
      }
    }

    return res.json({
      ok: true,
      subidas: resultados.filter(r => r.ok).length,
      fallidas: resultados.filter(r => !r.ok).length,
      pendientes,
      resultados,
      sinResolver,
    });
  } catch (err) {
    console.error('Error en /api/shopify/fotos:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
