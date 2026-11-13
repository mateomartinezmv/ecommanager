// api/_fallosStock.js
// Memoria de las publicaciones de MELI a las que el cron de stock no les pudo corregir el
// número (api/cron/sync-stock-pubs.js).
//
// El cron corre cada hora y antes avisaba por Telegram cada vez que corregía algo o que algo
// fallaba: una publicación trabada mandaba el mismo error todas las horas. Ahora corrige en
// silencio y sólo avisa cuando la misma publicación falla VECES_PARA_AVISAR corridas seguidas,
// una sola vez. Si se destraba y vuelve a fallar, el conteo arranca de cero.

const TABLA = 'stock_sync_fallos';
const VECES_PARA_AVISAR = 3;

// previos: filas de la tabla. fallidas: las de esta corrida ({ sku, meli_id, titulo, error }).
// Devuelve qué guardar, qué borrar (las que esta vez no fallaron) y de cuáles avisar ahora.
function contarFallos(previos, fallidas) {
  const anterior = new Map((previos || []).map(f => [f.meli_id, f]));
  const vistos = new Set();
  const filas = [];
  const avisar = [];

  for (const f of fallidas || []) {
    if (!f.meli_id || vistos.has(f.meli_id)) continue;
    vistos.add(f.meli_id);
    const prev = anterior.get(f.meli_id);
    const veces = (prev?.veces || 0) + 1;
    const yaAvisado = !!prev?.avisado;
    const toca = !yaAvisado && veces >= VECES_PARA_AVISAR;
    const fila = {
      meli_id: f.meli_id,
      sku: f.sku || null,
      titulo: f.titulo || null,
      error: f.error || null,
      veces,
      avisado: yaAvisado || toca,
    };
    filas.push(fila);
    if (toca) avisar.push(fila);
  }

  const borrar = (previos || []).map(f => f.meli_id).filter(id => !vistos.has(id));
  return { filas, borrar, avisar };
}

// Lee, cuenta y guarda. Devuelve las publicaciones de las que hay que avisar ahora. Si la
// tabla no existe (migración sin correr) no avisa nada: mejor callado que repetir cada hora.
async function registrarFallos(supabase, fallidas) {
  const { data: previos, error } = await supabase.from(TABLA).select('*');
  if (error) {
    console.error(`${TABLA}: no se pudo leer (${error.message}) — no se avisa nada`);
    return [];
  }

  const { filas, borrar, avisar } = contarFallos(previos, fallidas);
  const ahora = new Date().toISOString();

  if (filas.length) {
    const { error: e } = await supabase.from(TABLA).upsert(filas.map(f => ({ ...f, updated_at: ahora })));
    if (e) {
      console.error(`${TABLA}: no se pudo guardar (${e.message}) — no se avisa nada`);
      return [];
    }
  }
  if (borrar.length) await supabase.from(TABLA).delete().in('meli_id', borrar);

  return avisar;
}

module.exports = { contarFallos, registrarFallos, VECES_PARA_AVISAR, TABLA };
