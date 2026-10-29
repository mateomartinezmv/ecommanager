// api/shopify/fotos.js
// GET  /api/shopify/fotos              → qué productos de la tienda no tienen las fotos de MELI
// POST /api/shopify/fotos              → les pone las fotos de MELI, en todos los productos enlazados
// POST /api/shopify/fotos { sku }      → sólo al producto de ese SKU
// GET  /api/shopify/fotos?accion=subir[&sku=X] → lo mismo que el POST, para lanzarlo desde el navegador
//
// Las fotos se toman de la publicación principal de MELI (meli_ids[0]) y el producto de
// Shopify queda con exactamente esas, en el orden de MELI: lo que tenía de más se saca. Una
// foto de MELI que ya estaba cargada no se vuelve a subir (ver _fotos.js).
//
// Cada producto es un solo PUT con la lista completa de imágenes: si Shopify no puede bajar
// alguna, rechaza el PUT entero y el producto queda como estaba, nunca a medias.
//
// Shopify descarga cada foto nueva desde el CDN de MELI en el momento, así que cada producto
// tarda: una pasada sobre todo el catálogo puede no entrar en los 60s de la función. Se hace
// lo que entre y se avisa cuántos quedaron; volver a llamar sigue desde ahí, porque los ya
// hechos quedan al día.

const { getMeliToken } = require('../_meliToken');
const { getShopifyToken } = require('../_shopifyToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet } = require('../_meliPublicaciones');
const { shopifyFetch } = require('../_stockSync');
const { fotosDe } = require('../meli/_fotos');
const { armarPlan, alDia } = require('./_fotos');

const LOTE_MELI = 20;     // multiget de MELI
const LOTE_SHOPIFY = 50;  // nodes() de GraphQL
const TOPE_MS = 45000;    // la función se corta a los 60s (vercel.json) y un PUT puede tardar

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
          id product { id title images(first:100){ edges{ node{ id url } } } } } } }`,
        variables: { ids: lote.map(id => `gid://shopify/ProductVariant/${id}`) },
      }),
    });
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    for (const n of data.data?.nodes || []) {
      if (!n?.product) continue;
      mapa[n.id.split('/').pop()] = {
        productId: n.product.id.split('/').pop(),
        titulo: n.product.title,
        imagenes: (n.product.images?.edges || []).map(e => ({ id: e.node.id.split('/').pop(), url: e.node.url })),
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
    const subir = req.method === 'POST' || (req.method === 'GET' && req.query?.accion === 'subir');
    if (!subir && req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const { productos, sinResolver, shopifyToken } = await planificar(supabase, skuFiltro);
    const desactualizados = productos.filter(f => !f.alDia);

    if (!subir) {
      return res.json({
        ok: true,
        resumen: {
          productos: productos.length,
          a_actualizar: desactualizados.length,
          fotos_nuevas: desactualizados.reduce((s, f) => s + f.nuevas, 0),
          fotos_sacadas: desactualizados.reduce((s, f) => s + f.sacadas, 0),
          sin_resolver: sinResolver.length,
        },
        productos: productos.map(f => ({
          productId: f.productId, titulo: f.titulo, skus: f.skus, meli_ids: f.meli_ids, alDia: f.alDia,
          en_shopify: f.imagenes.length, en_meli: f.objetivo.length, nuevas: f.nuevas, sacadas: f.sacadas,
        })),
        sinResolver,
      });
    }

    if (skuFiltro && !productos.length && !sinResolver.length) {
      return res.status(404).json({ ok: false, error: `${skuFiltro} no está enlazado a MELI y a Shopify.` });
    }

    // No corta ante un fallo: un producto que Shopify rechaza no deja sin fotos al resto.
    const inicio = Date.now();
    const resultados = [];
    let pendientes = 0;
    for (const fila of desactualizados) {
      if (Date.now() - inicio > TOPE_MS) { pendientes++; continue; }
      const base = { productId: fila.productId, titulo: fila.titulo, skus: fila.skus };
      try {
        const data = await shopifyFetch(shopifyToken, `/products/${fila.productId}.json`, {
          method: 'PUT',
          body: JSON.stringify({ product: { id: Number(fila.productId), images: fila.cuerpo } }),
        });
        // Lo que quedó lo dice Shopify, no lo que mandamos.
        const quedaron = (data.product?.images || []).map(i => ({ id: String(i.id), url: i.src }));
        resultados.push({
          ...base, ok: true, antes: fila.imagenes.length, ahora: quedaron.length, nuevas: fila.nuevas, sacadas: fila.sacadas,
          aviso: alDia(fila.objetivo, quedaron)
            ? null
            : `Shopify dejó ${quedaron.length} de las ${fila.objetivo.length} fotos de MELI, o en otro orden. Revisá el producto.`,
        });
      } catch (err) {
        resultados.push({ ...base, ok: false, error: err.message });
      }
    }

    return res.json({
      ok: true,
      actualizados: resultados.filter(r => r.ok).length,
      fallidos: resultados.filter(r => !r.ok).length,
      pendientes,
      al_dia: productos.length - desactualizados.length,
      resultados,
      sinResolver,
    });
  } catch (err) {
    console.error('Error en /api/shopify/fotos:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
