// api/_meliPreguntas.js
// Helpers para la API de preguntas de MELI (questions, api_version=4)

const API = 'https://api.mercadolibre.com';
const MAX_RESPUESTA = 2000; // límite de MELI

const FIRMA = 'Saludos, Mateo de Martinez Motos';
const BARRIO = 'Belvedere, Montevideo';

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

// ¿Es el primer contacto de este comprador en esta publicación, o ya viene
// conversando? Sirve para no repetir la firma en cada respuesta de una ida y
// vuelta. Ante la duda devuelve true: firmar de más molesta menos que no
// firmar un primer contacto.
async function esPrimeraPregunta(token, pregunta) {
  const fromId = pregunta.from?.id ?? pregunta.buyer_id;
  if (!fromId || !pregunta.item_id) return true;

  try {
    const data = await meliGet(
      token,
      `/questions/search?item=${pregunta.item_id}&from=${fromId}&api_version=4&limit=50`
    );
    const previas = (data.questions || []).filter(
      (q) =>
        String(q.id) !== String(pregunta.id) &&
        new Date(q.date_created) < new Date(pregunta.date_created)
    );
    return previas.length === 0;
  } catch (e) {
    console.error('esPrimeraPregunta:', e.message);
    return true;
  }
}

// La firma la pone el código y no el modelo: pedírsela al modelo es pedirle
// que acierte todas las veces. Si el texto ya se firma, no la duplica.
function aplicarFirma(texto, primeraPregunta) {
  const limpio = String(texto).trim();
  if (!primeraPregunta) return limpio;
  if (/martinez\s+motos/i.test(limpio)) return limpio;
  return `${limpio}\n\n${FIRMA}`;
}

function construirPrompt(pregunta, titulo) {
  return `Sos quien responde las preguntas de Mercado Libre de Martinez Motos, una tienda de accesorios para motos en Uruguay.

Un comprador preguntó esto sobre la publicación "${titulo}":

"${pregunta.text}"

Escribí la respuesta en español rioplatense (voseo), amable y directa. Máximo 3 oraciones.

Reglas que no podés romper:
- Nunca des dirección exacta, teléfono, email, WhatsApp, redes sociales ni página web. Mercado Libre sanciona las respuestas con datos de contacto.
- Si preguntan dónde están o por la dirección, decí únicamente que están en ${BARRIO}. Nada más específico que el barrio.
- No inventes medidas, materiales, compatibilidades ni plazos que no estén en el título de la publicación. Si no lo sabés con certeza, pedile el dato que falta (modelo y año de la moto, por ejemplo) para poder confirmarle.
- Si preguntan por disponibilidad o envío: hay stock y se envía a todo Uruguay.
- No firmes ni te despidas. La firma se agrega por separado.

Escribí solamente el texto de la respuesta, sin comillas ni explicaciones.`;
}

async function redactarRespuesta(token, pregunta, titulo) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('Falta ANTHROPIC_API_KEY');
    err.code = 'SIN_API_KEY';
    throw err;
  }

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
      messages: [{ role: 'user', content: construirPrompt(pregunta, titulo) }],
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Anthropic HTTP ${res.status}`);
  }

  const texto = data.content?.[0]?.text?.trim();
  if (!texto) throw new Error('La IA no devolvió texto');

  const primera = await esPrimeraPregunta(token, pregunta);
  return { texto: aplicarFirma(texto, primera), primeraPregunta: primera };
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
  FIRMA,
  getSellerId,
  listarSinResponder,
  obtenerPregunta,
  titulosDeItems,
  esPrimeraPregunta,
  aplicarFirma,
  redactarRespuesta,
  responderPregunta,
};
