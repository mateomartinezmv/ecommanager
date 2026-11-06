// api/_higgsfield.js
// Cliente mínimo de la API de Higgsfield (https://api.higgsfield.ai).
//
// La API no genera en el momento: se manda el pedido al endpoint del modelo, devuelve un
// request_id, y el estado se consulta en /requests/{id}/status hasta que queda en
// completed / failed / nsfw / canceled. Es el mismo contrato que usa el SDK oficial
// (@higgsfield/client v2): autenticación "Authorization: Key ID:SECRET".
//
// La clave se crea en https://console.higgsfield.ai y se carga en Vercel como
// HIGGSFIELD_API_KEY = "ID:SECRET" (o HF_API_KEY_ID + HF_API_KEY_SECRET por separado).
// Es facturación de la API, aparte de los créditos de la app de Higgsfield.

const API = 'https://api.higgsfield.ai';
const TERMINALES = new Set(['completed', 'failed', 'nsfw', 'canceled']);

function credenciales() {
  const junta = String(process.env.HIGGSFIELD_API_KEY || process.env.HF_CREDENTIALS || '').trim();
  if (junta.includes(':')) return junta;
  const id = String(process.env.HF_API_KEY_ID || process.env.HF_API_KEY || '').trim();
  const secreto = String(process.env.HF_API_KEY_SECRET || process.env.HF_API_SECRET || '').trim();
  return id && secreto ? `${id}:${secreto}` : null;
}

const configurado = () => !!credenciales();

class ErrorHiggsfield extends Error {
  constructor(mensaje, status, data) {
    super(mensaje);
    this.status = status ?? null;   // null = no hubo respuesta (red caída, timeout)
    this.data = data;
  }
}

async function llamar(metodo, ruta, cuerpo) {
  const cred = credenciales();
  if (!cred) throw new ErrorHiggsfield('Falta HIGGSFIELD_API_KEY en Vercel (ID:SECRET de console.higgsfield.ai).', 0);

  let res;
  try {
    res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Key ${cred}`,
        Accept: 'application/json',
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      // Nunca seguir una redirección con la clave puesta.
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw new ErrorHiggsfield(`Higgsfield no respondió: ${e.message}`, null);
  }

  const texto = await res.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto.slice(0, 300) }; }
  if (!res.ok) {
    const detalle = typeof data.detail === 'string' ? data.detail
      : Array.isArray(data.detail) ? data.detail.map(d => d.msg || JSON.stringify(d)).join(' · ')
      : data.message || data.error || '';
    const porStatus = {
      401: 'La clave de Higgsfield no es válida.',
      402: 'No hay saldo en la cuenta de la API de Higgsfield.',
      403: 'Higgsfield rechazó el pedido (sin saldo o sin acceso a ese modelo).',
      429: 'Higgsfield está al límite de pedidos simultáneos.',
    };
    throw new ErrorHiggsfield([porStatus[res.status], detalle].filter(Boolean).join(' ') || `Higgsfield HTTP ${res.status}`, res.status, data);
  }
  return data;
}

// Manda un pedido al modelo. Devuelve el request_id.
async function enviar(modelo, input) {
  const data = await llamar('POST', `/${modelo.replace(/^\//, '')}`, input);
  const id = String(data.request_id || '');
  // Aceptado pero sin id: se puede haber cobrado y no hay forma de seguirlo.
  if (!/^[0-9a-f-]{16,}$/i.test(id)) {
    throw new ErrorHiggsfield('Higgsfield aceptó el pedido pero no devolvió un request_id.', null, data);
  }
  return id;
}

// Estado de un pedido: { status, terminal, respuesta }.
async function estado(requestId) {
  const data = await llamar('GET', `/requests/${encodeURIComponent(requestId)}/status`);
  const status = String(data.status || '');
  return { status, terminal: TERMINALES.has(status), respuesta: data };
}

module.exports = { configurado, enviar, estado, ErrorHiggsfield, TERMINALES };
