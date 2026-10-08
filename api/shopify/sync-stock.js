// api/shopify/sync-stock.js
// POST /api/shopify/sync-stock          → repasa todos los productos vivos
// POST /api/shopify/sync-stock { sku }  → sólo ese producto
//
// Red de seguridad: deja Shopify (y de paso MELI) en el número que dice el
// depósito. En el día a día no hace falta correrlo —cada venta, devolución e
// importación ya sincroniza sola—, pero sirve después de una importación de
// CSV, de un cambio a mano en el admin de Shopify o para auditar que los tres
// números coinciden.
//
// Los productos sin shopify_id no se saltean: sincronizarStock los busca por
// SKU en Shopify y guarda el enlace. Los que no existan en la tienda (los
// extensores, por ejemplo) quedan listados como omitidos.

const { getSupabase } = require('../_supabase');
const { sincronizarStock, resumenSync } = require('../_stockSync');
const { FILTRO_SYNC_STOCK } = require('../_discontinuado');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();
    const skuFiltro = req.body?.sku || null;

    let query = supabase
      .from('productos')
      .select('sku, nombre, shopify_id, stock_dep, unidades_por_venta, meli_id, meli_ids')
      // Igual que en meli/sync-stock: el descatalogado con unidades sigue vendiendo, así que
      // sigue sincronizando; el que está en cero queda afuera.
      .or(FILTRO_SYNC_STOCK);
    if (skuFiltro) query = query.eq('sku', skuFiltro);

    const { data: productos, error } = await query.order('sku');
    if (error) throw error;
    if (!productos.length) return res.json({ ok: true, mensaje: 'No hay productos para sincronizar' });

    const sincronizados = [];
    const omitidos = [];
    const fallos = [];

    for (const p of productos) {
      const sync = await sincronizarStock(supabase, p, p.stock_dep);
      console.log('🔁', resumenSync(p.sku, sync));

      if (sync.error) { fallos.push({ sku: p.sku, error: sync.error }); continue; }

      if (sync.shopify.sincronizada) {
        sincronizados.push({
          sku: p.sku,
          stock: sync.stockPublicado,
          enlazado: sync.shopify.enlazado || undefined,
        });
      } else if (/no existe en Shopify/.test(sync.shopify.error || '')) {
        omitidos.push({ sku: p.sku, motivo: 'no está en Shopify' });
      } else {
        fallos.push({ sku: p.sku, error: `Shopify: ${sync.shopify.error}` });
      }

      for (const e of sync.meli.errores) {
        fallos.push({ sku: p.sku, error: `MELI${e.meliId ? ` ${e.meliId}` : ''}: ${e.error}` });
      }
    }

    res.json({
      ok: true,
      sincronizados: sincronizados.length,
      omitidos: omitidos.length,
      errores: fallos.length,
      detalle: sincronizados,
      sinShopify: omitidos,
      fallos,
    });
  } catch (err) {
    console.error('Error en sync-stock:', err);
    res.status(500).json({ error: err.message });
  }
};
