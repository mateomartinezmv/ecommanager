// api/_telegramPreguntas.js
// Preguntas de MELI → Telegram con la respuesta ya redactada y dos botones.
//
// Cuando entra una pregunta, el bot arma la respuesta sugerida y la manda junto con
// "✅ Aceptar" y "❌ Rechazar". Aceptar la publica en MELI tal cual; Rechazar la descarta
// (se responde a mano desde MELI o desde el CRM). No hay que escribirle nada al bot.
//
// Cada pregunta tiene su fila en telegram_preguntas (question_id = clave primaria):
//   · El INSERT es la reserva. MELI manda el mismo aviso varias veces (reintenta si
//     tardamos en contestarle, y redactar con IA tarda), y sólo el que logra insertar avisa.
//   · Guarda la respuesta sugerida: el botón de Telegram sólo puede llevar 64 bytes, así que
//     lleva el id de la pregunta y el texto se lee de acá.
//   · Antes había una sola fila de "pregunta pendiente" y cada pregunta nueva pisaba a la
//     anterior. Ahora cada una tiene la suya y sus propios botones.
//
// Estados: avisando → pendiente (con botones) | sin_borrador (no se pudo redactar)
//          pendiente → publicando → publicada
//          pendiente → rechazada
//          pendiente | sin_borrador → respondida_fuera (se contestó desde MELI o el CRM)
//          avisando → ignorada (cuando se fue a mirar ya no estaba sin responder)

const { esc, enviar, editar, responderBoton } = require('./_telegram');
const { getMeliToken } = require('./_meliToken');
const {
  obtenerPregunta, titulosDeItems, redactarRespuesta, responderPregunta, MAX_RESPUESTA,
} = require('./_meliPreguntas');

const TABLA = 'telegram_preguntas';
const ahora = () => new Date().toISOString();

function textoAviso(fila, pie) {
  let t =
    `❓ <b>Nueva pregunta en MELI</b>\n\n` +
    `📦 <b>Producto:</b> ${esc(fila.item_titulo || fila.item_id || '—')}\n` +
    `💬 <b>Pregunta:</b> ${esc(fila.pregunta)}`;
  if (fila.respuesta) t += `\n\n📝 <b>Respuesta sugerida:</b>\n${esc(fila.respuesta)}`;
  if (pie) t += `\n\n${pie}`;
  return t;
}

function botones(questionId) {
  return [[
    { text: '✅ Aceptar', callback_data: `pq:ok:${questionId}` },
    { text: '❌ Rechazar', callback_data: `pq:no:${questionId}` },
  ]];
}

async function leerFila(supabase, questionId) {
  const { data } = await supabase.from(TABLA).select('*').eq('question_id', String(questionId)).maybeSingle();
  return data || null;
}

async function guardar(supabase, questionId, cambios) {
  return supabase.from(TABLA).update({ ...cambios, updated_at: ahora() }).eq('question_id', String(questionId));
}

// Pasa de un estado a otro sólo si la fila sigue en el de partida. Es lo que impide que dos
// toques seguidos de "Aceptar" publiquen dos veces.
async function tomar(supabase, questionId, desde, hacia) {
  const { data } = await supabase
    .from(TABLA)
    .update({ estado: hacia, updated_at: ahora() })
    .eq('question_id', String(questionId))
    .eq('estado', desde)
    .select('question_id');
  return !!(data && data.length);
}

// ── Pregunta nueva (desde el webhook de MELI) ──────────────────────────────
async function avisarPregunta(supabase, questionId) {
  const qid = String(questionId);

  const { error: errReserva } = await supabase.from(TABLA).insert({ question_id: qid, estado: 'avisando' });
  if (errReserva) {
    // Ya la avisó otro aviso de MELI. Si mientras tanto se respondió desde MELI, se le
    // sacan los botones al mensaje.
    if (errReserva.code === '23505') {
      await revisarSiSeRespondio(supabase, qid);
      return { estado: 'ya_avisada' };
    }
    console.error(`telegram_preguntas: no se pudo reservar ${qid}:`, errReserva.message);
    return { estado: 'error', error: errReserva.message };
  }

  let token, q;
  try {
    token = await getMeliToken();
    q = await obtenerPregunta(token, qid);
  } catch (err) {
    // No se avisó nada: se libera la reserva para que el próximo aviso de MELI lo intente.
    await supabase.from(TABLA).delete().eq('question_id', qid);
    throw err;
  }

  if (q.status !== 'UNANSWERED') {
    await guardar(supabase, qid, { estado: 'ignorada' });
    return { estado: 'no_pendiente' };
  }

  const titulos = await titulosDeItems(token, [q.item_id]);
  const fila = {
    item_id: q.item_id || null,
    item_titulo: titulos[q.item_id] || q.item_id || null,
    pregunta: q.text || '',
    respuesta: null,
  };

  let motivo = null;
  try {
    const borrador = await redactarRespuesta(token, q, fila.item_titulo);
    if (borrador.texto.length > MAX_RESPUESTA) {
      motivo = `la respuesta salió de ${borrador.texto.length} caracteres y MELI acepta ${MAX_RESPUESTA}`;
    } else {
      fila.respuesta = borrador.texto;
    }
  } catch (err) {
    motivo = err.code === 'SIN_API_KEY' ? 'falta la API de Claude' : err.message;
  }

  const mensaje = fila.respuesta
    ? await enviar(textoAviso(fila), { botones: botones(qid) })
    : await enviar(textoAviso(fila, `⚠️ No pude armar una respuesta (${esc(motivo)}). Respondela desde MELI.`));

  if (!mensaje) {
    await supabase.from(TABLA).delete().eq('question_id', qid);
    return { estado: 'telegram_fallo' };
  }

  const estado = fila.respuesta ? 'pendiente' : 'sin_borrador';
  await guardar(supabase, qid, { ...fila, estado, message_id: mensaje.message_id });
  return { estado };
}

// Un aviso repetido de una pregunta que ya está en Telegram: si ya no está sin responder,
// se respondió por fuera del bot y el mensaje deja de ofrecer los botones.
async function revisarSiSeRespondio(supabase, qid) {
  const fila = await leerFila(supabase, qid);
  if (!fila || !['pendiente', 'sin_borrador'].includes(fila.estado)) return;
  try {
    const token = await getMeliToken();
    const q = await obtenerPregunta(token, qid);
    if (q.status === 'UNANSWERED') return;
  } catch (err) {
    console.error(`telegram_preguntas: no se pudo revisar ${qid}:`, err.message);
    return;
  }
  await marcarRespondidaFuera(supabase, qid, 'desde MELI');
}

// La pregunta se contestó sin los botones (desde MELI o desde el CRM): el mensaje lo dice y
// pierde los botones, para que nadie publique una segunda respuesta.
async function marcarRespondidaFuera(supabase, questionId, donde) {
  const fila = await leerFila(supabase, questionId);
  if (!fila || !['avisando', 'pendiente', 'sin_borrador'].includes(fila.estado)) return false;
  await guardar(supabase, questionId, { estado: 'respondida_fuera' });
  if (fila.message_id) await editar(fila.message_id, textoAviso(fila, `✅ Respondida ${donde}.`));
  return true;
}

// ── Botón tocado (desde el webhook de Telegram) ────────────────────────────
async function resolverBoton(supabase, callback) {
  const m = /^pq:(ok|no):(\d+)$/.exec(callback.data || '');
  if (!m) {
    await responderBoton(callback.id);
    return { estado: 'desconocido' };
  }
  const [, accion, qid] = m;
  const messageId = callback.message?.message_id;

  const fila = await leerFila(supabase, qid);
  if (!fila || !fila.respuesta) {
    await responderBoton(callback.id, 'No encontré esa respuesta. Respondela desde MELI.');
    return { estado: 'sin_fila' };
  }

  if (accion === 'no') {
    if (!(await tomar(supabase, qid, 'pendiente', 'rechazada'))) {
      await responderBoton(callback.id, 'Esa pregunta ya estaba resuelta.');
      return { estado: 'ya_resuelta' };
    }
    await editar(messageId, textoAviso(fila, '❌ Rechazada. Respondela desde MELI o desde el CRM.'));
    await responderBoton(callback.id, 'Rechazada');
    return { estado: 'rechazada' };
  }

  if (!(await tomar(supabase, qid, 'pendiente', 'publicando'))) {
    await responderBoton(callback.id, 'Esa pregunta ya estaba resuelta.');
    return { estado: 'ya_resuelta' };
  }

  try {
    const token = await getMeliToken();
    // La fuente de verdad es MELI: pudo haberse respondido desde ahí después del aviso.
    const q = await obtenerPregunta(token, qid);
    if (q.status !== 'UNANSWERED') {
      await guardar(supabase, qid, { estado: 'respondida_fuera' });
      await editar(messageId, textoAviso(fila, 'ℹ️ Ya estaba respondida en MELI. No se publicó nada.'));
      await responderBoton(callback.id, 'Ya estaba respondida');
      return { estado: 'respondida_fuera' };
    }
    await responderPregunta(token, qid, fila.respuesta);
  } catch (err) {
    // Vuelve a pendiente: los botones siguen sirviendo para reintentar.
    await guardar(supabase, qid, { estado: 'pendiente' });
    await responderBoton(callback.id, 'No se pudo publicar');
    await enviar(
      `❌ <b>No se pudo publicar la respuesta</b>\n\n` +
      `📦 ${esc(fila.item_titulo)}\n${esc(err.message)}\n\n` +
      `Probá de nuevo con el botón o respondela desde MELI.`
    );
    return { estado: 'error', error: err.message };
  }

  await guardar(supabase, qid, { estado: 'publicada' });
  await editar(messageId, textoAviso(fila, '✅ Publicada en MELI.'));
  await responderBoton(callback.id, 'Publicada ✅');
  return { estado: 'publicada' };
}

module.exports = { avisarPregunta, resolverBoton, marcarRespondidaFuera, textoAviso, TABLA };
