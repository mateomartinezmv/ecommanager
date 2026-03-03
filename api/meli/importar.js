// api/meli/importar.js
// POST /api/meli/importar → importa todas las publicaciones de MELI a Supabase

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

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
    let omitidos = 0;
    const errores = [];

    for (const batch of batches) {
      const idsParam = batch.join(',');
      const itemsRes = await fetch(`https://api.mercadolibre.com/items?ids=${idsParam}&attributes=id,title,price,available_quantity,category_id,status,thumbnail`, {
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

        // Verificar si ya existe un producto con ese meli_id
        const { data: existente } = await supabase
          .from('productos')
          .select('sku')
          .eq('meli_id', item.id)
          .single();

        if (existente) {
          omitidos++;
          continue;
        }

        // Generar SKU automático basado en el ID de MELI
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
          categoria: '',
          stock_dep: item.available_quantity,
          stock_meli: item.available_quantity,
          costo: 0,
          precio: item.price,
          alerta_min: 3,
          meli_id: item.id,
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
      omitidos,
      errores: errores.length,
      total: ids.length,
      mensaje: `${importados} productos importados, ${omitidos} omitidos (ya existían o inactivos)`
    });

  } catch (err) {
    console.error('Error importando desde MELI:', err);
    res.status(500).json({ error: err.message });
  }
};
