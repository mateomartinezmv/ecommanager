// api/_telegramCola.js
// Mensajes para el chat del dueño escritos por algo que no tiene el token del bot: las
// tareas programadas de Claude (la revisión semanal de Ads). Insertan una fila en
// telegram_cola y el cron api/cron/telegram-cola.js la manda.
//
//   · Un texto de más de 4096 caracteres (el tope de Telegram) sale partido en varios
//     mensajes, cortando entre párrafos.
//   · El texto va con HTML. Si Telegram lo rechaza (una etiqueta mal cerrada), se manda el
//     mismo texto sin formato antes que perderlo.
//   · Cada fila se toma con un UPDATE condicionado: dos corridas del cron no la mandan dos
//     veces. Si falla, vuelve a pendiente y se reintenta hasta MAX_INTENTOS.

const { enviar } = require('./_telegram');

const TABLA = 'telegram_cola';
const MAX_CARACTERES = 4000;     // con margen sobre los 4096 de Telegram
const MAX_INTENTOS = 5;
const POR_CORRIDA = 10;

function partir(texto, max = MAX_CARACTERES) {
  const partes = [];
  let actual = '';
  const agregar = (trozo, sep) => {
    if (!actual) { actual = trozo; return; }
    if (actual.length + sep.length + trozo.length <= max) { actual += sep + trozo; return; }
    partes.push(actual);
    actual = trozo;
  };
  for (const parrafo of String(texto).split('\n\n')) {
    if (parrafo.length <= max) { agregar(parrafo, '\n\n'); continue; }
    // Un párrafo enorme: por líneas y, si una línea sola no entra, a la fuerza.
    for (const linea of parrafo.split('\n')) {
      if (linea.length <= max) { agregar(linea, '\n'); continue; }
      for (let i = 0; i < linea.length; i += max) agregar(linea.slice(i, i + max), '\n');
    }
  }
  if (actual) partes.push(actual);
  return partes;
}

// Un trozo con HTML; si Telegram lo rechaza, sin formato.
async function mandarTrozo(trozo) {
  if (await enviar(trozo)) return true;
  return !!(await enviar(trozo, { html: false }));
}

async function enviarCola(supabase) {
  const { data: pendientes, error } = await supabase
    .from(TABLA)
    .select('id, texto, intentos')
    .eq('estado', 'pendiente')
    .order('id', { ascending: true })
    .limit(POR_CORRIDA);
  if (error) throw new Error(`${TABLA}: ${error.message}`);

  const resultados = [];
  for (const fila of pendientes || []) {
    const { data: tomada } = await supabase
      .from(TABLA)
      .update({ estado: 'enviando' })
      .eq('id', fila.id)
      .eq('estado', 'pendiente')
      .select('id');
    if (!tomada?.length) continue;

    const trozos = partir(fila.texto);
    let enviados = 0;
    for (const trozo of trozos) {
      if (!(await mandarTrozo(trozo))) break;
      enviados++;
    }

    if (enviados === trozos.length) {
      await supabase.from(TABLA)
        .update({ estado: 'enviado', enviado_at: new Date().toISOString(), error: null })
        .eq('id', fila.id);
      resultados.push({ id: fila.id, estado: 'enviado', mensajes: trozos.length });
      continue;
    }

    // Si ya salió una parte, reintentar mandaría esa parte de nuevo: se corta acá.
    const intentos = (fila.intentos || 0) + 1;
    const definitivo = enviados > 0 || intentos >= MAX_INTENTOS;
    const motivo = enviados > 0
      ? `Se mandaron ${enviados} de ${trozos.length} partes y Telegram rechazó la siguiente`
      : 'Telegram no aceptó el mensaje';
    await supabase.from(TABLA)
      .update({ estado: definitivo ? 'error' : 'pendiente', intentos, error: motivo })
      .eq('id', fila.id);
    resultados.push({ id: fila.id, estado: definitivo ? 'error' : 'reintentar', error: motivo });
  }
  return resultados;
}

module.exports = { partir, enviarCola, TABLA, MAX_CARACTERES, MAX_INTENTOS };
