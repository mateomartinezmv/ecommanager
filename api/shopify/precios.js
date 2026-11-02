// api/shopify/precios.js
// GET  /api/shopify/precios                       → los descuentos activos de MELI y cómo quedaría cada
//                                                   producto en Shopify (no cambia nada)
// GET  /api/shopify/precios?sku=X                 → lo mismo, sólo ese SKU
// POST /api/shopify/precios [{ sku }]             → los copia a Shopify
// GET  /api/shopify/precios?accion=aplicar[&sku=X] → lo mismo que el POST, para lanzarlo desde el navegador
//
// Copiar un descuento es dejar la variante de Shopify con:
//   compare_at_price = precio de lista de MELI   (la tienda lo muestra tachado)
//   price            = precio final de MELI       (con el descuento)
// Si el SKU tiene varias publicaciones con descuento a precios finales distintos, manda la
// de precio final más alto (ver _descuentos.js). Los SKUs sin descuento activo no se tocan.

const { getMeliToken } = require('../_meliToken');
const { getShopifyToken } = require('../_shopifyToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet } = require('../_meliPublicaciones');
const { shopifyFetch } = require('../_stockSync');
const { promocionesDeItem, descuentoVigente } = require('../meli/precios');
const { armarPlan } = require('./_descuentos');

const LOTE_MELI = 20;      // multiget de MELI
const CONCURRENCIA = 8;    // promociones: una llamada por publicación
const LOTE_SHOPIFY = 50;   // nodes() de GraphQL
const TOPE_MS = 45000;     // la función se corta a los 60s (vercel.json)

// Estado y descuento vigente de cada publicación.
async function publicacionesMeli(token, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const mapa = {};
  for (let i = 0; i < unicos.length; i += LOTE_MELI) {
    const lote = unicos.slice(i, i + LOTE_MELI);
    const data = await meliGet(token, `/items?ids=${lote.join(',')}&attributes=id,title,status,price`);
    for (const e of data || []) {
      if (e.code === 200 && e.body?.id) {
        mapa[e.body.id] = { meli_id: e.body.id, titulo: e.body.title || null, estado: e.body.status || null, descuento: null };
      }
    }
  }

  const activas = Object.keys(mapa).filter(id => mapa[id].estado === 'active');
  for (let i = 0; i < activas.length; i += CONCURRENCIA) {
    await Promise.all(activas.slice(i, i + CONCURRENCIA).map(async (id) => {
      mapa[id].descuento = descuentoVigente(await promocionesDeItem(token, id));
    }));
  }
  return mapa;
}

// Precio y precio de comparación actuales de cada variante enlazada.
async function variantesShopify(token, variantIds) {
  const mapa = {};
  for (let i = 0; i < variantIds.length; i += LOTE_SHOPIFY) {
    const lote = variantIds.slice(i, i + LOTE_SHOPIFY);
    const data = await shopifyFetch(token, '/graphql.json', {
      method: 'POST',
      body: JSON.stringify({
        query: `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant {
          id title price compareAtPrice product { id title } } } }`,
        variables: { ids: lote.map(id => `gid://shopify/ProductVariant/${id}`) },
      }),
    });
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    for (const n of data.data?.nodes || []) {
      if (!n?.product) continue;
      mapa[n.id.split('/').pop()] = {
        productId: n.product.id.split('/').pop(),
        titulo: n.product.title,
        variante: n.title === 'Default Title' ? null : n.title,
        precio: n.price,
        compare_at: n.compareAtPrice,
      };
    }
  }
  return mapa;
}

async function planificar(supabase, skuFiltro = '') {
  const { data, error } = await supabase
    .from('productos')
    .select('sku, nombre, meli_id, meli_ids, shopify_id, discontinuado')
    .order('nombre');
  if (error) throw error;

  const productos = (data || [])
    .filter(p => !p.discontinuado && meliIdsDe(p).length)
    .filter(p => !skuFiltro || p.sku === skuFiltro);

  const [meliToken, shopifyToken] = await Promise.all([getMeliToken(), getShopifyToken()]);
  const variantIds = [...new Set(productos.map(p => p.shopify_id).filter(Boolean).map(String))];
  const [pubs, shopify] = await Promise.all([
    publicacionesMeli(meliToken, productos.flatMap(meliIdsDe)),
    variantesShopify(shopifyToken, variantIds),
  ]);

  const plan = armarPlan(
    productos.map(p => ({
      sku: p.sku,
      nombre: p.nombre,
      variantId: p.shopify_id ? String(p.shopify_id) : null,
      publicaciones: meliIdsDe(p).map(id => pubs[id]).filter(Boolean),
    })),
    shopify
  );
  return { ...plan, revisados: productos.length, shopifyToken };
}

// Shopify deja 2 llamadas REST por segundo: ante un 429 se espera y se reintenta.
async function actualizarVariante(token, variantId, nuevo) {
  for (let intento = 0; ; intento++) {
    try {
      const data = await shopifyFetch(token, `/variants/${variantId}.json`, {
        method: 'PUT',
        body: JSON.stringify({ variant: { id: Number(variantId), price: nuevo.precio, compare_at_price: nuevo.compare_at } }),
      });
      return data.variant || {};
    } catch (err) {
      if (intento < 3 && /exceeded|429|throttl/i.test(err.message)) {
        await new Promise(r => setTimeout(r, 1000 * (intento + 1)));
        continue;
      }
      throw err;
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const aplicar = req.method === 'POST' || (req.method === 'GET' && req.query?.accion === 'aplicar');
    if (!aplicar && req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const skuFiltro = String(req.body?.sku || req.query?.sku || '').trim();
    const { filas, sinShopify, revisados, shopifyToken } = await planificar(getSupabase(), skuFiltro);
    const pendientesDeCambio = filas.filter(f => !f.alDia);

    if (!aplicar) {
      return res.json({
        ok: true,
        resumen: {
          productos_revisados: revisados,
          con_descuento: filas.length + sinShopify.length,
          a_actualizar: pendientesDeCambio.length,
          al_dia: filas.length - pendientesDeCambio.length,
          sin_shopify: sinShopify.length,
          publicaciones_desparejas: filas.filter(f => f.descuento.precios_distintos).length,
        },
        productos: filas,
        sinShopify,
      });
    }

    const inicio = Date.now();
    const resultados = [];
    let pendientes = 0;
    for (const f of pendientesDeCambio) {
      if (Date.now() - inicio > TOPE_MS) { pendientes++; continue; }
      const base = { sku: f.sku, nombre: f.nombre, variantId: f.variantId, antes: f.actual, pedido: f.nuevo };
      try {
        const v = await actualizarVariante(shopifyToken, f.variantId, f.nuevo);
        // Lo que quedó lo dice Shopify, no lo que mandamos.
        resultados.push({ ...base, ok: true, ahora: { precio: v.price ?? null, compare_at: v.compare_at_price ?? null } });
      } catch (err) {
        resultados.push({ ...base, ok: false, error: err.message });
      }
    }

    return res.json({
      ok: true,
      actualizados: resultados.filter(r => r.ok).length,
      fallidos: resultados.filter(r => !r.ok).length,
      pendientes,
      al_dia: filas.length - pendientesDeCambio.length,
      resultados,
      sinShopify,
    });
  } catch (err) {
    console.error('Error en /api/shopify/precios:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
