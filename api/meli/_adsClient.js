// api/meli/_adsClient.js
// Helpers compartidos por los endpoints de Mercado Ads.
//
// Todos ellos necesitan lo mismo antes de poder preguntar nada: token, el advertiser_id de
// la cuenta y el site_id. Resolverlo son dos llamadas que no cambian entre requests, así
// que se cachean en memoria del lambda (sobreviven mientras la instancia esté caliente).

const { getMeliToken } = require('../_meliToken');

const API = 'https://api.mercadolibre.com';
const CACHE_MS = 10 * 60 * 1000;
let cache = null;   // { contexto, expira }

// MELI sólo sirve métricas de los últimos 90 días; más atrás devuelve 400 para todo el
// rango, no sólo para los días que faltan.
const VENTANA_DIAS = 90;

const aFecha = d => d.toISOString().slice(0, 10);
const sumarDias = (d, n) => new Date(d.getTime() + n * 86400000);

/**
 * Devuelve { headers, advertiserId, siteId, currency } listo para pegarle a Ads.
 * Lanza un Error con `.sinAcceso = true` cuando la cuenta no tiene perfil de anunciante,
 * para que el endpoint pueda contestar 200 con un mensaje en vez de un 500.
 */
async function getAdsContext() {
  if (cache && cache.expira > Date.now()) return cache.contexto;

  const token = await getMeliToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const meRes = await fetch(`${API}/users/me`, { headers });
  const me = await meRes.json();
  if (!me.id) throw new Error('No se pudo obtener el usuario MELI');

  const advRes = await fetch(
    `${API}/advertising/advertisers?user_id=${me.id}&product_id=PADS`,
    { headers: { ...headers, 'Api-Version': '1' } }
  );
  const advData = await advRes.json();
  if (!advRes.ok || !advData.advertisers?.length) {
    const err = new Error('No se encontró perfil de anunciante en MELI Ads.');
    err.sinAcceso = true;
    throw err;
  }

  const { advertiser_id: advertiserId, site_id: siteId } = advData.advertisers[0];
  const contexto = {
    headers,
    advertiserId,
    siteId,
    currency: me.currency_id || (siteId === 'MLU' ? 'UYU' : 'USD'),
  };

  cache = { contexto, expira: Date.now() + CACHE_MS };
  return contexto;
}

/** GET contra la API de Ads. Devuelve { ok, status, body } sin tirar excepción por 4xx. */
async function adsGet(url, headers, apiVersion = '2') {
  const r = await fetch(url, { headers: { ...headers, 'Api-Version': apiVersion } });
  const text = await r.text();
  let body = {};
  if (text) { try { body = JSON.parse(text); } catch { body = { raw: text }; } }
  return { ok: r.ok, status: r.status, body };
}

/**
 * Normaliza el rango pedido a lo que MELI puede contestar.
 * Devuelve { desde, hasta, recortado } — `recortado` avisa cuándo se movió el borde.
 */
function resolverRango({ desde, hasta, dias }) {
  const hoy = new Date();
  // Un día de margen sobre los 90: el corte se mueve durante el día y pedir el borde
  // exacto hace fallar el request entero.
  const masViejo = aFecha(sumarDias(hoy, -(VENTANA_DIAS - 1)));

  let d, h;
  if (desde || hasta) {
    d = desde || masViejo;
    h = hasta || aFecha(hoy);
  } else {
    const n = Math.max(1, parseInt(dias || '30', 10));
    d = aFecha(sumarDias(hoy, -(n - 1)));
    h = aFecha(hoy);
  }

  const pedido = d;
  if (d < masViejo) d = masViejo;
  if (h > aFecha(hoy)) h = aFecha(hoy);

  return {
    desde: d,
    hasta: h,
    vacio: d > h,
    recortado: pedido < d ? { pedido, motivo: 'MELI sólo sirve 90 días de métricas' } : null,
  };
}

/** Corre `tarea` sobre `items` con un tope de concurrencia, preservando el orden. */
async function enLotes(items, limite, tarea) {
  const salida = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      salida[i] = await tarea(items[i], i);
    }
  });
  await Promise.all(workers);
  return salida;
}

module.exports = { API, getAdsContext, adsGet, resolverRango, enLotes, aFecha, sumarDias };
