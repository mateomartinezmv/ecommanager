// api/_discontinuado.js
// Catálogo de motivos de descatalogado y armado de las columnas que lo guardan.
//
// Descatalogar es decir "de este producto no compro más": sale de reposición, de los avisos
// de stock bajo y de la sincronización masiva de stock, pero las unidades que queden se
// siguen vendiendo normalmente (y cada venta le sigue bajando el stock a MELI y Shopify).
//
// El catálogo está acá y espejado en public/index.html — el SPA es un HTML plano sin
// bundler, así que no hay forma de importar este archivo desde el front. Al agregar un
// motivo hay que tocar los dos lugares; esta lista es la que manda, porque es la que valida
// antes de escribir en la base.

const MOTIVOS_DISCONTINUADO = [
  { id: 'poca_venta',    nombre: 'Poca venta',               color: '#f59e0b' },
  { id: 'poco_margen',   nombre: 'Poco margen de ganancia',  color: '#eab308' },
  { id: 'problematico',  nombre: 'Producto problemático',    color: '#ef4444' },
  { id: 'sin_proveedor', nombre: 'No se consigue más',       color: '#64748b' },
  { id: 'reemplazado',   nombre: 'Reemplazado por otro',     color: '#4f8ef7' },
  { id: 'competencia',   nombre: 'No competitivo en precio', color: '#a78bfa' },
  { id: 'otro',          nombre: 'Otro motivo',              color: '#94a3b8' },
];

const IDS_MOTIVO = new Set(MOTIVOS_DISCONTINUADO.map(m => m.id));

// Un motivo que no está en el catálogo se guarda como NULL en vez de rechazar el guardado:
// perder el motivo es menos grave que perder el descatalogado entero, y la pantalla lo
// muestra como "sin motivo registrado".
function normalizarMotivo(valor) {
  const slug = String(valor ?? '').trim();
  return IDS_MOTIVO.has(slug) ? slug : null;
}

function normalizarFecha(valor) {
  const s = String(valor ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Las tres columnas se escriben juntas y siempre en bloque: descatalogar las llena,
// reactivar las vacía. Dejar un motivo colgado de un producto activo haría que el análisis
// cuente productos que volvieron a venderse.
//
// `body` es el cuerpo del request (camelCase) y `anterior` la fila que ya estaba, para poder
// respetar lo que no se manda: guardar un producto desde el formulario de edición no tiene
// que borrarle el motivo ni reactivarlo sin querer.
function camposDiscontinuado(body, anterior) {
  const discontinuado = body.discontinuado !== undefined
    ? !!body.discontinuado
    : !!anterior?.discontinuado;

  if (!discontinuado) {
    return { discontinuado: false, motivo_discontinuado: null, nota_discontinuado: null, fecha_discontinuado: null };
  }

  // Si el request no trae motivo (ej. el formulario de producto, que no lo pregunta), se
  // conserva el que ya tenía.
  const motivo = body.motivoDiscontinuado !== undefined
    ? normalizarMotivo(body.motivoDiscontinuado)
    : (anterior?.motivo_discontinuado ?? null);

  const nota = body.notaDiscontinuado !== undefined
    ? (String(body.notaDiscontinuado).trim() || null)
    : (anterior?.nota_discontinuado ?? null);

  // La fecha la manda el front (su "hoy", el del navegador del usuario) porque el servidor
  // corre en UTC: descatalogar a las 22:00 de Uruguay quedaría fechado mañana.
  const fecha = normalizarFecha(body.fechaDiscontinuado)
    || anterior?.fecha_discontinuado
    || new Date().toISOString().slice(0, 10);

  return { discontinuado: true, motivo_discontinuado: motivo, nota_discontinuado: nota, fecha_discontinuado: fecha };
}

const COLUMNAS_MOTIVO = ['motivo_discontinuado', 'nota_discontinuado', 'fecha_discontinuado'];

// ¿El error es "esa columna no existe"? Pasa cuando el deploy llega antes que la migración.
// PostgREST devuelve PGRST204 al mandar una columna desconocida en un insert/update y 42703
// cuando el error sube crudo de Postgres; el match por nombre cubre el resto.
function faltaMigracionMotivo(error) {
  if (!error) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  const msg = String(error.message || '');
  return COLUMNAS_MOTIVO.some(c => msg.includes(c)) && /column|columna/i.test(msg);
}

// Escribe la fila con las columnas del motivo y, si todavía no existen en la base, repite el
// write sin ellas. Así un deploy adelantado a la migración no rompe el alta ni la edición de
// productos: lo único que se pierde es el motivo, y la respuesta lo avisa con
// `migracionMotivoPendiente` para que la pantalla lo muestre.
//
// `escribir` recibe la fila y devuelve lo mismo que un .select().single() de Supabase:
// { data, error }.
async function escribirConMotivo(escribir, filaBase, filaMotivo) {
  const completo = { ...filaBase, ...filaMotivo };
  const primero = await escribir(completo);
  if (!faltaMigracionMotivo(primero.error)) return { ...primero, migracionMotivoPendiente: false };

  // `discontinuado` sí existe desde antes, así que el reintento lo conserva.
  const sinMotivo = { ...filaBase, discontinuado: filaMotivo.discontinuado };
  const reintento = await escribir(sinMotivo);
  return { ...reintento, migracionMotivoPendiente: !reintento.error };
}

module.exports = {
  MOTIVOS_DISCONTINUADO,
  normalizarMotivo,
  camposDiscontinuado,
  faltaMigracionMotivo,
  escribirConMotivo,
  COLUMNAS_MOTIVO,
};
