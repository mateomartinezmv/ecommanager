// api/meli/debug-item.js
// GET /api/meli/debug-item?id=MLU123[,MLU456]  → la publicación tal cual la devuelve MELI
// GET /api/meli/debug-item?sku=DOM00           → todas las publicaciones enlazadas a ese SKU
// GET /api/meli/debug-item?id=…&crudo=1        → el ítem completo, sin recortar
//
// Sólo lectura: no crea ni modifica nada. Existe porque desde afuera no se puede mirar una
// publicación (la API de MELI pide token para /items), y hay preguntas que sólo se contestan
// viendo el ítem crudo: si tiene variaciones y cuáles, en qué producto de usuario cae cada
// una, y de dónde sale el título que ve el comprador.
//
// El recorte por defecto muestra justo eso, porque un ítem completo son cientos de líneas de
// atributos que tapan lo único que se estaba buscando.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliGet } = require('../_meliPublicaciones');

// Lo que interesa de cada variación: su identidad, su stock y qué la distingue.
function resumirVariacion(v) {
  return {
    id: v.id,
    user_product_id: v.user_product_id || null,
    available_quantity: v.available_quantity,
    sold_quantity: v.sold_quantity,
    seller_custom_field: v.seller_custom_field || null,
    // Los atributos que arman el nombre de la variación (Color, Talle).
    combinaciones: (v.attribute_combinations || []).map(a => `${a.name || a.id}: ${a.value_name || a.value_id}`),
    sku_atributo: (v.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || null,
    fotos: (v.picture_ids || []).length,
  };
}

function resumirItem(it) {
  const variaciones = Array.isArray(it.variations) ? it.variations : [];
  return {
    id: it.id,
    title: it.title,
    family_name: it.family_name || null,
    user_product_id: it.user_product_id || null,
    status: it.status,
    sub_status: it.sub_status || [],
    available_quantity: it.available_quantity,
    sold_quantity: it.sold_quantity,
    price: it.price,
    category_id: it.category_id,
    catalog_listing: !!it.catalog_listing,
    catalog_product_id: it.catalog_product_id || null,
    seller_custom_field: it.seller_custom_field || null,
    permalink: it.permalink,
    // La respuesta a "¿esta publicación tiene variantes?".
    tiene_variaciones: variaciones.length > 0,
    cantidad_variaciones: variaciones.length,
    variaciones: variaciones.map(resumirVariacion),
    // Atributos que definen la variante cuando el ítem NO tiene variaciones: ahí el color
    // vive en el ítem mismo y es lo que MELI le pega al family_name para armar el título.
    color: (it.attributes || []).find(a => /^COLOR$/i.test(a.id))?.value_name || null,
    sku_atributo: (it.attributes || []).find(a => a.id === 'SELLER_SKU')?.value_name || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getMeliToken();

    let ids = String(req.query.id || '')
      .split(/[\s,;]+/)
      .map(s => s.trim())
      .filter(Boolean);

    const sku = String(req.query.sku || '').trim();
    if (sku) {
      const supabase = getSupabase();
      const { data: producto, error } = await supabase
        .from('productos')
        .select('sku, nombre, stock_dep, meli_id, meli_ids')
        .eq('sku', sku)
        .single();
      if (error || !producto) return res.status(404).json({ error: `No existe el SKU ${sku} en el CRM.` });
      ids = [...new Set([...ids, ...meliIdsDe(producto)])];
    }

    if (!ids.length) return res.status(400).json({ error: 'Falta id= (publicación MELI) o sku=.' });

    const crudo = req.query.crudo === '1';
    const items = [];
    const errores = [];

    for (const id of ids) {
      try {
        const it = await meliGet(token, `/items/${id}`);
        items.push(crudo ? it : resumirItem(it));
      } catch (err) {
        errores.push({ id, error: err.message });
      }
    }

    res.json({ ok: true, pedidos: ids.length, items, errores });
  } catch (err) {
    console.error('Error en meli/debug-item:', err);
    res.status(500).json({ error: err.message });
  }
};
