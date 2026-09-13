// api/meli/generar-respuesta.js
// POST /api/meli/generar-respuesta → genera una respuesta sugerida para una pregunta

const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const { question_id } = req.body || {};
  if (!question_id) {
    return res.status(400).json({ ok: false, error: 'Falta question_id' });
  }

  try {
    const supabase = getSupabase();

    // Encontrar la pregunta en bot_estado
    const { data: estados } = await supabase
      .from('bot_estado')
      .select('*')
      .eq('accion_pendiente->>question_id', question_id);

    if (!estados || estados.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Pregunta no encontrada',
      });
    }

    const estado = estados[0];
    const pregunta = estado.accion_pendiente;

    if (!pregunta || pregunta.tipo !== 'responder_pregunta') {
      return res.status(400).json({
        ok: false,
        error: 'La pregunta no es válida',
      });
    }

    // Generar respuesta con Claude
    const prompt = `Sos el asistente de un vendedor de accesorios para motos en Uruguay en Mercado Libre.

Un comprador hizo esta pregunta sobre el producto "${pregunta.item_titulo}":

"${pregunta.pregunta}"

Escribí una respuesta corta, amigable y en español rioplatense (con voseo). Máximo 3 oraciones.
- Si la pregunta es sobre disponibilidad, precio o envío, respondé positivamente indicando que tienen stock y envían a todo Uruguay.
- Si es una pregunta técnica específica que no podés responder con certeza, sugerí que se contacten por mensaje privado.
- Sé directo y útil.`;

    const iaRes = await fetch('https://api.anthropic.com/v1/messages', {
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

    const iaData = await iaRes.json();
    const respuestaSugerida = iaData.content?.[0]?.text || 'No se pudo generar una respuesta.';

    return res.status(200).json({
      ok: true,
      question_id,
      item_titulo: pregunta.item_titulo,
      pregunta: pregunta.pregunta,
      comprador: pregunta.comprador,
      respuesta_sugerida: respuestaSugerida,
      instrucciones: 'Revisá esta respuesta. Si te parece bien, usá el endpoint POST /api/meli/preguntas con question_id y respuesta para publicarla. Si no te parece, ignorá esta sugerencia.',
    });
  } catch (err) {
    console.error('Error generando respuesta:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};
