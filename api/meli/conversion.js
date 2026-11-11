// api/meli/conversion.js
// GET /api/meli/conversion?dias=30 → los productos activos ordenados por tasa de conversión
// en MELI, de menor a mayor, y si tienen fotos nuevas publicadas desde Marketing → 📸 Fotos.
//
// Sólo lectura. Las visitas salen de MELI (piden token, por eso vive acá y no se puede mirar
// desde afuera); las ventas, de la tabla ventas del CRM. La cuenta está en ./_conversion.js.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const { meliFetch } = require('../_meliPublicaciones');
const { armarFilas, rango } = require('./_conversion');

const LOTE = 20;
const TOPE_MS = 50000;

// Visitas de cada publicación en el período. Primero por lotes (/items/visits); lo que MELI no
// devuelva así se pide de a una (/items/{id}/visits/time_window). Lo que tampoco llegue queda
// sin dato: la fila lo muestra como "sin dato", no como 0 visitas.
async function traerVisitas(token, ids, { desde, hasta, dias }) {
  const inicio = Date.now();
  const visitas = {};
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const r = await meliFetch(token, `/items/visits?ids=${lote.join(',')}&date_from=${desde}&date_to=${hasta}`);
    if (!r.ok) continue;
    for (const x of [].concat(r.data || [])) {
      if (x && x.item_id && x.total_visits != null) visitas[x.item_id] = Number(x.total_visits) || 0;
    }
  }
  const faltan = ids.filter(id => visitas[id] == null);
  for (let i = 0; i < faltan.length && Date.now() - inicio < TOPE_MS; i += 6) {
    await Promise.all(faltan.slice(i, i + 6).map(async id => {
      const r = await meliFetch(token, `/items/${id}/visits/time_window?last=${dias}&unit=day`);
      if (r.ok && r.data && r.data.total_visits != null) visitas[id] = Number(r.data.total_visits) || 0;
    }));
  }
  return visitas;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 150);
  const { desde, hasta } = rango(dias);
  const supabase = getSupabase();

  try {
    let token;
    try { token = await getMeliToken(); } catch {
      return res.status(400).json({ error: 'MELI no está conectado. Autorizá la app primero.' });
    }

    const { data: productos, error } = await supabase.from('productos')
      .select('sku, nombre, grupo, subgrupo, meli_id, meli_ids, discontinuado');
    if (error) throw error;

    const { data: ventas, error: errVentas } = await supabase.from('ventas')
      .select('sku, cantidad, canal, estado, fecha')
      .eq('canal', 'meli').gte('fecha', desde);
    if (errVentas) throw errVentas;

    // Fotos nuevas: las que se publicaron desde 📸 Fotos (generadas o subidas). Si la tabla
    // todavía no existe, la columna queda en "no" para todos.
    const { data: fotos } = await supabase.from('fotos_ia').select('sku').eq('estado', 'publicada');
    const skusConFotos = [...new Set((fotos || []).map(f => f.sku))];

    const activos = (productos || []).filter(p => !p.discontinuado);
    const ids = [...new Set(activos.flatMap(meliIdsDe))];
    const visitasPorItem = await traerVisitas(token, ids, { desde, hasta, dias });

    const filas = armarFilas({ productos: activos, visitasPorItem, ventas, skusConFotos });
    return res.json({
      dias, desde, hasta,
      publicaciones: ids.length,
      publicaciones_sin_dato: ids.filter(id => visitasPorItem[id] == null).length,
      productos: filas,
    });
  } catch (err) {
    console.error('Error en meli/conversion.js:', err);
    return res.status(500).json({ error: err.message });
  }
};
