// api/_meliIds.js
// Un SKU puede tener varias publicaciones MELI (es común duplicar una
// publicación con distintos ángulos de venta). productos.meli_ids las lista
// todas; productos.meli_id es sólo la principal (= meli_ids[0]).
//
// Toda búsqueda "de qué producto es esta orden" y todo empuje de stock a MELI
// tienen que pasar por acá: si se filtra por meli_id a secas, las ventas de
// las publicaciones secundarias se pierden en silencio.

// Normaliza lo que venga (array, string con separadores, null) a string[].
function parseMeliIds(valor) {
  const crudos = Array.isArray(valor)
    ? valor
    : String(valor || '').split(/[\s,;]+/);

  const vistos = new Set();
  const ids = [];
  for (const raw of crudos) {
    const id = String(raw || '').trim();
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }
  return ids;
}

// Todas las publicaciones de un producto, tolerando filas viejas que todavía
// sólo tengan meli_id.
function meliIdsDe(producto) {
  if (!producto) return [];
  const ids = parseMeliIds(producto.meli_ids);
  if (ids.length) return ids;
  return parseMeliIds(producto.meli_id);
}

// Busca el producto dueño de una publicación, mire donde mire el dato.
// Devuelve null si no hay ninguno (el llamador decide qué hacer con eso).
async function buscarProductoPorMeliId(supabase, meliItemId, columnas = '*') {
  const id = String(meliItemId || '').trim();
  if (!id) return null;

  const { data: porArray } = await supabase
    .from('productos')
    .select(columnas)
    .contains('meli_ids', [id])
    .limit(1);
  if (porArray && porArray.length) return porArray[0];

  // Respaldo para filas anteriores a la migración de meli_ids.
  const { data: porLegacy } = await supabase
    .from('productos')
    .select(columnas)
    .eq('meli_id', id)
    .limit(1);
  if (porLegacy && porLegacy.length) return porLegacy[0];

  return null;
}

module.exports = { parseMeliIds, meliIdsDe, buscarProductoPorMeliId };
