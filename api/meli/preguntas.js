// api/meli/preguntas.js
// GET  /api/meli/preguntas                          → preguntas sin responder (lee de MELI)
// POST /api/meli/preguntas { question_id }           → sugiere una respuesta (NO publica)
// POST /api/meli/preguntas { question_id, respuesta} → publica la respuesta en MELI
//
// Requiere header: Authorization: Bearer $ADMIN_SECRET
// Publica texto público en nombre del vendedor, así que sin ADMIN_SECRET seteado
// el endpoint responde 401 siempre.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const {
  MAX_RESPUESTA,
  getSellerId,
  listarSinResponder,
  obtenerPregunta,
  titulosDeItems,
  responderPregunta,
} = require('../_meliPreguntas');

function autorizado(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  return req.headers['authorization'] === `Bearer ${secret}`;
}

async function sugerirRespuesta(pregunta, titulo) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Falta ANTHROPIC_API_KEY');
  }

  const prompt = `Sos el asistente de Martinez Motos, una tienda de accesorios para motos en Uruguay que vende por Mercado Libre.

Un comprador preguntó esto sobre el producto "${titulo}":

"${pregunta.text}"

Escribí una respuesta corta, amigable y en español rioplatense (voseo). Máximo 3 oraciones.
- Si pregunta por disponibilidad, precio o envío: respondé que hay stock y que se envía a todo Uruguay.
- Si es una consulta técnica que no podés responder con certeza, invitá a escribir por mensaje privado.
- No inventes especificaciones, medidas ni compatibilidades que no estén en el título.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Anthropic HTTP ${res.status}`);
  }
  const texto = data.content?.[0]?.text?.trim();
  if (!texto) throw new Error('La IA no devolvió texto');
  return texto;
}

module.exports = async (req, res) => {
  if (!autorizado(req)) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  try {
    const token = await getMeliToken();

    // ── Listar preguntas sin responder ──────────────────────────
    if (req.method === 'GET') {
      const sellerId = await getSellerId(token);
      const { total, questions } = await listarSinResponder(token, sellerId);
      const titulos = await titulosDeItems(token, questions.map(q => q.item_id));

      return res.status(200).json({
        ok: true,
        total,
        count: questions.length,
        preguntas: questions.map(q => ({
          question_id: q.id,
          item_id: q.item_id,
          item_titulo: titulos[q.item_id] || q.item_id,
          pregunta: q.text,
          from_id: q.from?.id ?? null,
          fecha: q.date_created,
        })),
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Método no permitido' });
    }

    const { question_id, respuesta } = req.body || {};
    if (!question_id) {
      return res.status(400).json({ ok: false, error: 'Falta question_id' });
    }

    // El estado real lo tiene MELI, no la tabla bot_estado (que sólo guarda
    // la última pregunta recibida y no se limpia al responder).
    const pregunta = await obtenerPregunta(token, question_id);
    if (pregunta.status !== 'UNANSWERED') {
      return res.status(409).json({
        ok: false,
        error: `La pregunta ya no está sin responder (status: ${pregunta.status})`,
      });
    }

    const titulos = await titulosDeItems(token, [pregunta.item_id]);
    const titulo = titulos[pregunta.item_id] || pregunta.item_id;

    // ── Sin `respuesta` → sólo sugerir, no publica nada ─────────
    if (respuesta === undefined) {
      const sugerida = await sugerirRespuesta(pregunta, titulo);
      return res.status(200).json({
        ok: true,
        publicada: false,
        question_id: pregunta.id,
        item_titulo: titulo,
        pregunta: pregunta.text,
        respuesta_sugerida: sugerida,
        siguiente_paso: 'Para publicarla, repetí el POST agregando el campo "respuesta".',
      });
    }

    // ── Con `respuesta` → publicar en MELI ──────────────────────
    const texto = String(respuesta).trim();
    if (!texto) {
      return res.status(400).json({ ok: false, error: 'La respuesta está vacía' });
    }
    if (texto.length > MAX_RESPUESTA) {
      return res.status(400).json({
        ok: false,
        error: `La respuesta supera el máximo de ${MAX_RESPUESTA} caracteres (tiene ${texto.length})`,
      });
    }

    const resultado = await responderPregunta(token, pregunta.id, texto);

    // Limpiar el estado del bot de Telegram si apuntaba a esta pregunta,
    // para que no la vuelva a ofrecer como pendiente.
    try {
      const supabase = getSupabase();
      await supabase
        .from('bot_estado')
        .update({ accion_pendiente: null })
        .eq('accion_pendiente->>question_id', String(pregunta.id));
    } catch (e) {
      console.error('No se pudo limpiar bot_estado:', e.message);
    }

    return res.status(200).json({
      ok: true,
      publicada: true,
      question_id: pregunta.id,
      item_titulo: titulo,
      respuesta: texto,
      meli: resultado,
    });
  } catch (err) {
    console.error('Error en /api/meli/preguntas:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
