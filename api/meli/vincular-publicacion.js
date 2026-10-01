// api/meli/vincular-publicacion.js
// POST /api/meli/vincular-publicacion   { sku, meli_id }
// POST /api/meli/vincular-publicacion   { sku, meli_id, quitar: true }
//
// Agrega (o saca) una publicación de MELI a la lista de un producto del CRM.
//
// Existe para la pestaña de Ads: cuando un anuncio no vincula con ningún producto,
// desde la tabla se elige el SKU y se engancha el MLU sin tener que abrir Stock y
// reescribir el producto entero. Toca únicamente meli_ids — el trigger
// productos_meli_ids_sync se encarga de normalizar, de espejar meli_id y de rechazar una
// publicación que ya sea de otro SKU.

const { getSupabase } = require('../_supabase');
const { parseMeliIds, meliIdsDe } = require('../_meliIds');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sku = String(req.body?.sku || '').trim();
  const meliId = String(req.body?.meli_id || '').trim();
  const quitar = req.body?.quitar === true;

  if (!sku) return res.status(400).json({ ok: false, error: 'Falta el SKU' });
  if (!meliId) return res.status(400).json({ ok: false, error: 'Falta el ID de la publicación' });

  try {
    const supabase = getSupabase();

    const { data: producto, error: errBuscar } = await supabase
      .from('productos')
      .select('sku, nombre, meli_id, meli_ids')
      .eq('sku', sku)
      .single();
    if (errBuscar || !producto) {
      return res.status(404).json({ ok: false, error: `No existe el producto ${sku}` });
    }

    const actuales = meliIdsDe(producto);

    if (quitar) {
      const ids = actuales.filter(id => id !== meliId);
      if (ids.length === actuales.length) {
        return res.json({ ok: true, sin_cambio: true, sku, meli_ids: actuales });
      }
      return await guardar(supabase, sku, ids, res);
    }

    if (actuales.includes(meliId)) {
      return res.json({ ok: true, sin_cambio: true, sku, meli_ids: actuales });
    }

    // Al final: la primera de la lista es la publicación principal y vincular desde Ads
    // no debería cambiar cuál es.
    return await guardar(supabase, sku, parseMeliIds([...actuales, meliId]), res);

  } catch (err) {
    console.error('Error en vincular-publicacion.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function guardar(supabase, sku, ids, res) {
  const { data, error } = await supabase
    .from('productos')
    .update({ meli_ids: ids })
    .eq('sku', sku)
    .select('sku, nombre, meli_id, meli_ids')
    .single();

  if (error) {
    // El trigger tira unique_violation con el SKU dueño en el mensaje: pasarlo tal cual
    // es más útil que un "error al guardar".
    return res.status(409).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, sku: data.sku, nombre: data.nombre, meli_ids: data.meli_ids });
}
