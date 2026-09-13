// api/_meliPreguntas.js
// Helpers para la API de preguntas de MELI (questions, api_version=4)

const API = 'https://api.mercadolibre.com';
const MAX_RESPUESTA = 2000; // límite de MELI

async function meliGet(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`MELI ${path}: ${data.message || data.error}`);
  return data;
}

async function getSellerId(token) {
  const me = await meliGet(token, '/users/me');
  return me.id;
}

async function listarSinResponder(token, sellerId, limit = 50) {
  const data = await meliGet(
    token,
    `/questions/search?seller_id=${sellerId}&status=UNANSWERED` +
    `&api_version=4&sort_fields=date_created&sort_types=DESC&limit=${limit}`
  );
  return { total: data.total || 0, questions: data.questions || [] };
}

async function obtenerPregunta(token, questionId) {
  return meliGet(token, `/questions/${questionId}?api_version=4`);
}

// Multiget de títulos: MELI acepta hasta 20 ids por llamada.
async function titulosDeItems(token, itemIds) {
  const unicos = [...new Set(itemIds.filter(Boolean))];
  const titulos = {};
  for (let i = 0; i < unicos.length; i += 20) {
    const lote = unicos.slice(i, i + 20);
    try {
      const data = await meliGet(token, `/items?ids=${lote.join(',')}&attributes=id,title`);
      for (const entry of data) {
        if (entry.code === 200 && entry.body?.id) titulos[entry.body.id] = entry.body.title;
      }
    } catch (e) {
      console.error('titulosDeItems:', e.message);
    }
  }
  return titulos;
}

async function responderPregunta(token, questionId, texto) {
  const res = await fetch(`${API}/answers`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question_id: Number(questionId), text: texto }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.message || data.error || `HTTP ${res.status}`);
  }
  return data;
}

module.exports = {
  MAX_RESPUESTA,
  getSellerId,
  listarSinResponder,
  obtenerPregunta,
  titulosDeItems,
  responderPregunta,
};
