// api/_invocar.js
// Llama a un endpoint de api/ dentro del mismo proceso, sin pasar por HTTP, y devuelve lo
// que respondió: { status, data }.
//
// Sirve para que un cron reuse la cuenta exacta de una pestaña del CRM (Ads, Promos) en vez
// de reescribirla: si la pestaña cambia su criterio, el cron cambia con ella.

function invocar(handler, { method = 'GET', query = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      setHeader() { return res; },
      status(code) { status = code; return res; },
      json(data) { resolve({ status, data }); return res; },
      end() { resolve({ status, data: null }); return res; },
    };
    Promise.resolve()
      .then(() => handler({ method, query, body, headers: {} }, res))
      // Un handler que termina sin responder no deja la promesa colgada.
      .then(() => resolve({ status, data: null }), reject);
  });
}

module.exports = { invocar };
