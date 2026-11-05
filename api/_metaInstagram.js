// api/_metaInstagram.js
// Publicación en Instagram por la Graph API de Meta (Instagram API con inicio de sesión de
// Facebook). Lo usan api/meta/instagram.js (pantalla y "publicar ahora") y el cron
// api/cron/instagram-publicar.js (lo programado).
//
// Cómo publica Meta: primero se crea un "contenedor" con la URL pública de la imagen
// (Meta la descarga desde su lado), se espera a que termine de procesarlo y recién ahí se
// publica. Un carrusel son N contenedores hijos más uno padre que los agrupa. La API no
// programa: publica en el momento, por eso el horario lo maneja el cron.
//
// Limitaciones de Meta que conviene tener a mano:
//   · Imágenes: solo JPEG, por URL pública (no se suben bytes).
//   · Carrusel: de 2 a 10 imágenes.
//   · Historias: sin texto (la API no acepta caption) y sin stickers de enlace.
//   · Texto: hasta 2.200 caracteres y 30 hashtags.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const TIPOS = ['post', 'carrusel', 'historia'];
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
// Una publicación programada que quedó más atrás que esto se rechaza al cargarla: es más
// probable que sea un error de fecha que algo que se quiera publicar ya mismo.
const TOLERANCIA_PASADO_MS = 5 * 60 * 1000;

// Lo que pide el inicio de sesión de Facebook para encontrar la cuenta de Instagram
// vinculada a la página y poder publicar en ella.
const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
];

function contarHashtags(texto) {
  return (String(texto || '').match(/#[^\s#]+/g) || []).length;
}

// Acepta las imágenes como array o como texto con una URL por línea (lo que manda el
// formulario del CRM).
function normalizarImagenes(imagenes) {
  const lista = Array.isArray(imagenes) ? imagenes : String(imagenes || '').split(/[\r\n,]+/);
  return lista.map(u => String(u || '').trim()).filter(Boolean);
}

// Deja la publicación lista para guardar o devuelve { error } con un mensaje para mostrar.
// `ahora` se puede inyectar para los tests.
function armarPublicacion(body, ahora = new Date()) {
  const tipo = String(body.tipo || '').toLowerCase();
  if (!TIPOS.includes(tipo)) return { error: "El tipo tiene que ser 'post', 'carrusel' o 'historia'" };

  const imagenes = normalizarImagenes(body.imagenes);
  if (!imagenes.length) return { error: 'Falta al menos una imagen' };
  const malas = imagenes.filter(u => !/^https:\/\/\S+$/i.test(u));
  if (malas.length) return { error: `Las imágenes tienen que ser URLs públicas https: ${malas[0]}` };

  if (tipo === 'carrusel' && (imagenes.length < 2 || imagenes.length > 10)) {
    return { error: 'Un carrusel lleva de 2 a 10 imágenes' };
  }
  if (tipo !== 'carrusel' && imagenes.length !== 1) {
    return { error: `Un ${tipo} lleva una sola imagen (para varias, usá un carrusel)` };
  }

  let caption = String(body.caption || '').trim();
  if (tipo === 'historia') {
    // Meta no acepta texto en las historias por API: se descarta en vez de fallar al publicar.
    caption = '';
  }
  if (caption.length > MAX_CAPTION) return { error: `El texto tiene ${caption.length} caracteres (máximo ${MAX_CAPTION})` };
  if (contarHashtags(caption) > MAX_HASHTAGS) return { error: `El texto tiene más de ${MAX_HASHTAGS} hashtags` };

  const fecha = new Date(body.programadoPara || body.programado_para || '');
  if (Number.isNaN(fecha.getTime())) return { error: 'Falta la fecha y hora de publicación' };
  if (fecha.getTime() < ahora.getTime() - TOLERANCIA_PASADO_MS) {
    return { error: 'La fecha de publicación ya pasó' };
  }

  return {
    publicacion: {
      tipo,
      imagenes,
      caption: caption || null,
      programado_para: fecha.toISOString(),
      notas: String(body.notas || '').trim() || null,
    },
  };
}

// Llama a la Graph API y devuelve el JSON, o tira un Error con el mensaje de Meta.
async function graph(fetchImpl, method, path, params, token) {
  // El intercambio del code por token va sin access_token: se autentica con el secreto de la app.
  const qs = new URLSearchParams(token ? { ...params, access_token: token } : params);
  const url = `${GRAPH}/${path}`;
  const res = method === 'GET'
    ? await fetchImpl(`${url}?${qs}`)
    : await fetchImpl(url, { method, body: qs });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(e.error_user_msg || e.message || `Meta respondió ${res.status}`);
  }
  return data;
}

const pausa = ms => new Promise(r => setTimeout(r, ms));

// Meta procesa el contenedor en segundo plano: hay que esperar a FINISHED antes de publicar.
async function esperarContenedor(fetchImpl, id, token, { intentos = 10, cadaMs = 2000 } = {}) {
  for (let i = 0; i < intentos; i++) {
    const { status_code: estado, status } = await graph(fetchImpl, 'GET', id, { fields: 'status_code,status' }, token);
    if (estado === 'FINISHED') return;
    if (estado === 'ERROR' || estado === 'EXPIRED') {
      throw new Error(`Instagram no pudo procesar la imagen (${status || estado}). Revisá que sea un JPEG público.`);
    }
    if (i < intentos - 1) await pausa(cadaMs);
  }
  throw new Error('Instagram sigue procesando la imagen; se reintenta en la próxima vuelta');
}

// Publica una fila de instagram_publicaciones en la cuenta guardada en meta_tokens.
// Devuelve { mediaId, permalink }.
async function publicar(pub, cuenta, { fetchImpl = fetch, espera } = {}) {
  if (!cuenta?.ig_user_id || !cuenta?.page_access_token) {
    throw new Error('Instagram no está conectado. Conectalo desde la pantalla de Instagram del CRM.');
  }
  const ig = cuenta.ig_user_id;
  const token = cuenta.page_access_token;
  const caption = pub.caption || undefined;
  const sinVacios = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  let contenedor;
  if (pub.tipo === 'carrusel') {
    const hijos = [];
    for (const url of pub.imagenes) {
      const { id } = await graph(fetchImpl, 'POST', `${ig}/media`, { image_url: url, is_carousel_item: 'true' }, token);
      await esperarContenedor(fetchImpl, id, token, espera);
      hijos.push(id);
    }
    ({ id: contenedor } = await graph(fetchImpl, 'POST', `${ig}/media`,
      sinVacios({ media_type: 'CAROUSEL', children: hijos.join(','), caption }), token));
  } else if (pub.tipo === 'historia') {
    ({ id: contenedor } = await graph(fetchImpl, 'POST', `${ig}/media`,
      { media_type: 'STORIES', image_url: pub.imagenes[0] }, token));
  } else {
    ({ id: contenedor } = await graph(fetchImpl, 'POST', `${ig}/media`,
      sinVacios({ image_url: pub.imagenes[0], caption }), token));
  }
  await esperarContenedor(fetchImpl, contenedor, token, espera);

  const { id: mediaId } = await graph(fetchImpl, 'POST', `${ig}/media_publish`, { creation_id: contenedor }, token);
  // El permalink es un extra para mostrar en el CRM: si falla, la publicación ya salió igual.
  const permalink = await graph(fetchImpl, 'GET', mediaId, { fields: 'permalink' }, token)
    .then(d => d.permalink || null)
    .catch(() => null);
  return { mediaId, permalink };
}

// De las páginas que devuelve /me/accounts, la que tiene la cuenta de Instagram a usar:
// la de META_IG_USERNAME si está configurada, si no la primera con Instagram vinculado.
function elegirCuenta(paginas, usuarioPreferido) {
  const conIg = (paginas || []).filter(p => p.instagram_business_account?.id);
  const pref = String(usuarioPreferido || '').replace(/^@/, '').toLowerCase();
  return (pref && conIg.find(p => String(p.instagram_business_account.username || '').toLowerCase() === pref))
    || conIg[0]
    || null;
}

module.exports = {
  GRAPH, SCOPES, TIPOS, MAX_CAPTION,
  armarPublicacion, normalizarImagenes, publicar, elegirCuenta, graph,
};
