// api/meli/preguntas.js
// GET /api/meli/preguntas → obtiene preguntas pendientes de responder
// POST /api/meli/preguntas → responde una pregunta en MELI

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      // Obtener preguntas pendientes de Supabase
      const { data: estados } = await supabase
        .from('bot_estado')
        .select('*')
        .eq('accion_pendiente->>tipo', 'responder_pregunta');

      if (!estados || estados.length === 0) {
        return res.status(200).json({
          ok: true,
          count: 0,
          preguntas: [],
          mensaje: 'No hay preguntas pendientes',
        });
      }

      const preguntas = estados.map((estado) => ({
        id: estado.chat_id,
        question_id: estado.accion_pendiente.question_id,
        item_id: estado.accion_pendiente.item_id,
        item_titulo: estado.accion_pendiente.item_titulo,
        pregunta: estado.accion_pendiente.pregunta,
        comprador: estado.accion_pendiente.comprador,
        creada_en: estado.updated_at,
      }));

      return res.status(200).json({
        ok: true,
        count: preguntas.length,
        preguntas,
      });
    } catch (err) {
      console.error('Error obteniendo preguntas:', err.message);
      return res.status(500).json({
        ok: false,
        error: err.message,
      });
    }
  }

  if (req.method === 'POST') {
    const { question_id, respuesta } = req.body || {};

    if (!question_id || !respuesta) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan question_id o respuesta',
      });
    }

    try {
      const token = await getMeliToken();

      // Publicar respuesta en MELI
      const meliRes = await fetch(`https://api.mercadolibre.com/answers`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question_id,
          text: respuesta,
        }),
      });

      const meliData = await meliRes.json();

      if (meliData.error || meliData.status === 'ERROR') {
        return res.status(400).json({
          ok: false,
          error: `Error de MELI: ${meliData.message || JSON.stringify(meliData)}`,
        });
      }

      // Limpiar la acción pendiente de Supabase
      await supabase
        .from('bot_estado')
        .update({ accion_pendiente: null })
        .eq('accion_pendiente->>question_id', question_id);

      return res.status(200).json({
        ok: true,
        mensaje: '✅ Respuesta publicada en MELI',
        respuesta_meli: meliData,
      });
    } catch (err) {
      console.error('Error publicando respuesta:', err.message);
      return res.status(500).json({
        ok: false,
        error: err.message,
      });
    }
  }

  return res.status(405).json({ ok: false, error: 'Método no permitido' });
};
