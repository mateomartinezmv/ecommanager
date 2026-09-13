// api/meli/importar.js
// POST /api/meli/importar → importa todas las publicaciones de MELI a Supabase

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { buscarProductoPorMeliId, meliIdsDe } = require('../_meliIds');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = await getMeliToken();
    const supabase = getSupabase();

    // 1. Obtener usuario
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const me = await meRes.json();

    // 2. Obtener todos los IDs de publicaciones
    const searchRes = await fetch(`https://api.mercadolibre.com/users/${me.id}/items/search?limit=50`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const search = await searchRes.json();
    const ids = search.results || [];

    if (ids.length === 0) return res.json({ ok: true, importados: 0, mensaje: 'No tenés publicaciones activas en MELI' });

    // 3. Obtener detalles de cada publicación en batches de 20
    const batches = [];
    for (let i = 0; i < ids.length; i += 20) {
      batches.push(ids.slice(i, i + 20));
    }

    let importados = 0;
    let vinculados = 0;
    let omitidos = 0;
    const errores = [];

    for (const batch of batches) {
      const idsParam = batch.join(',');
      const itemsRes = await fetch(`https://api.mercadolibre.com/items?ids=${idsParam}&attributes=id,title,price,available_quantity,category_id,status,thumbnail,date_created,seller_custom_field`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const items = await itemsRes.json();

      for (const entry of items) {
        if (entry.code !== 200) {
          errores.push(entry.id);
          continue;
        }
        const item = entry.body;

        // Solo importar publicaciones activas
        if (item.status !== 'active') {
          omitidos++;
          continue;
        }

        // Verificar si esta publicación ya está vinculada a algún SKU
        const yaVinculada = await buscarProductoPorMeliId(supabase, item.id, 'sku');
        if (yaVinculada) {
          omitidos++;
          continue;
        }

        // Si la publicación lleva el SKU del vendedor y ese producto ya existe
        // en el CRM sin enlazar, la vinculamos en vez de crear un duplicado.
        const skuVendedor = (item.seller_custom_field || '').trim();
        if (skuVendedor) {
          const { data: propio } = await supabase
            .from('productos')
            .select('sku, meli_id, meli_ids, fecha_publicacion')
            .eq('sku', skuVendedor)
            .single();

          if (propio) {
            // Un SKU puede tener varias publicaciones: la que llega se suma a
            // las que ya tenía en vez de descartarse.
            const idsPrevios = meliIdsDe(propio);
            const esPrimera = idsPrevios.length === 0;

            const cambios = {
              meli_ids: [...idsPrevios, item.id],
              fecha_publicacion: propio.fecha_publicacion
                || (item.date_created ? item.date_created.slice(0, 10) : null),
            };
            // stock_meli espeja el depósito; sólo lo sembramos al primer enlace.
            if (esPrimera) cambios.stock_meli = item.available_quantity;

            const { error: linkErr } = await supabase.from('productos')
              .update(cambios).eq('sku', skuVendedor);

            if (linkErr) {
              console.error('Error enlazando:', skuVendedor, linkErr.message);
              errores.push(item.id);
            } else {
              vinculados++;
              console.log(`🔗 Enlazado: ${skuVendedor} → ${item.id}${esPrimera ? '' : ' (publicación adicional)'}`);
            }
            continue;
          }
        }

        // Sin SKU propio: generamos uno automático basado en el ID de MELI
        const sku = `MELI-${item.id}`;

        // Verificar que el SKU no exista
        const { data: skuExistente } = await supabase
          .from('productos')
          .select('sku')
          .eq('sku', sku)
          .single();

        if (skuExistente) {
          omitidos++;
          continue;
        }

        // Insertar producto
        const { error } = await supabase.from('productos').insert({
          sku,
          nombre: item.title,
          stock_dep: item.available_quantity,
          stock_meli: item.available_quantity,
          costo: 0,
          precio: item.price,
          alerta_min: 3,
          meli_ids: [item.id],
          fecha_publicacion: item.date_created ? item.date_created.slice(0, 10) : null,
          notas: `Importado desde MELI`,
        });

        if (error) {
          console.error('Error insertando:', item.id, error.message);
          errores.push(item.id);
        } else {
          importados++;
          console.log(`✅ Importado: ${item.title} (${item.id})`);
        }
      }
    }

    res.json({
      ok: true,
      importados,
      vinculados,
      omitidos,
      errores: errores.length,
      total: ids.length,
      mensaje: `${importados} productos importados, ${vinculados} enlazados por SKU, ${omitidos} omitidos (ya existían o inactivos)`
    });

  } catch (err) {
    console.error('Error importando desde MELI:', err);
    res.status(500).json({ error: err.message });
  }
};
