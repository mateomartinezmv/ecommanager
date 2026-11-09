// api/_metaInstagram.js
// Publicación en Instagram y en la página de Facebook por la Graph API de Meta (Instagram API
// con inicio de sesión de Facebook). Lo usan api/meta/instagram.js (pantalla y "publicar
// ahora") y el cron api/cron/instagram-publicar.js (lo programado).
//
// Cada publicación dice en qué redes sale (`redes`): Instagram, Facebook o las dos. Las dos
// usan el mismo token, el de la página de Facebook vinculada a la cuenta de Instagram.
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
const REDES = ['instagram', 'facebook'];
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
// Una publicación programada que quedó más atrás que esto se rechaza al cargarla: es más
// probable que sea un error de fecha que algo que se quiera publicar ya mismo.
const TOLERANCIA_PASADO_MS = 5 * 60 * 1000;

// Lo que pide el inicio de sesión de Facebook para encontrar la cuenta de Instagram
// vinculada a la página y poder publicar en las dos.
const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
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

// Sin redes indicadas sale en las dos. Acepta array o texto separado por comas.
function normalizarRedes(redes) {
  if (redes === undefined || redes === null || redes === '') return { redes: [...REDES] };
  const lista = (Array.isArray(redes) ? redes : String(redes).split(','))
    .map(r => String(r || '').trim().toLowerCase()).filter(Boolean);
  const malas = lista.filter(r => !REDES.includes(r));
  if (malas.length) return { error: `Red desconocida: ${malas[0]} (puede ser instagram o facebook)` };
  if (!lista.length) return { error: 'Elegí al menos una red: Instagram o Facebook' };
  // Siempre en el mismo orden (primero Instagram) y sin repetidas.
  return { redes: REDES.filter(r => lista.includes(r)) };
}

// Deja la publicación lista para guardar o devuelve { error } con un mensaje para mostrar.
// `ahora` se puede inyectar para los tests.
function armarPublicacion(body, ahora = new Date()) {
  const tipo = String(body.tipo || '').toLowerCase();
  if (!TIPOS.includes(tipo)) return { error: "El tipo tiene que ser 'post', 'carrusel' o 'historia'" };

  const { redes, error: errRedes } = normalizarRedes(body.redes);
  if (errRedes) return { error: errRedes };

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
      redes,
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

// Graph recibe los arrays de objetos como `clave[0]={...json...}`, `clave[1]=...`.
function aplanar(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x, i) => { out[`${k}[${i}]`] = typeof x === 'object' ? JSON.stringify(x) : x; });
    else out[k] = v;
  }
  return out;
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
    // Primero se crean todos los hijos y recién después se espera a cada uno: Meta los procesa
    // en paralelo, así un carrusel de 10 no tarda 10 veces lo que tarda una imagen.
    const hijos = [];
    for (const url of pub.imagenes) {
      const { id } = await graph(fetchImpl, 'POST', `${ig}/media`, { image_url: url, is_carousel_item: 'true' }, token);
      hijos.push(id);
    }
    for (const id of hijos) await esperarContenedor(fetchImpl, id, token, espera);
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

// Publica una fila en la página de Facebook guardada en meta_tokens.
// Devuelve { postId, permalink }.
//   · Post: una foto con el texto.
//   · Carrusel: las fotos se suben sin publicar y se adjuntan todas a un único posteo.
//   · Historia: la foto se sube sin publicar y se publica como historia de la página (sin texto).
async function publicarFacebook(pub, cuenta, { fetchImpl = fetch } = {}) {
  if (!cuenta?.page_id || !cuenta?.page_access_token) {
    throw new Error('Facebook no está conectado. Conectalo desde la pantalla de Redes del CRM.');
  }
  const page = cuenta.page_id;
  const token = cuenta.page_access_token;
  const message = pub.caption || undefined;
  const post = (path, params) => graph(fetchImpl, 'POST', path, aplanar(params), token);
  const fotoSinPublicar = url => post(`${page}/photos`, { url, published: 'false' }).then(r => r.id);

  let postId;
  if (pub.tipo === 'historia') {
    const fotoId = await fotoSinPublicar(pub.imagenes[0]);
    const r = await post(`${page}/photo_stories`, { photo_id: fotoId });
    postId = r.post_id || r.id;
  } else if (pub.tipo === 'carrusel') {
    // Las fotos se suben todas a la vez; Promise.all respeta el orden del carrusel.
    const fotos = (await Promise.all(pub.imagenes.map(fotoSinPublicar))).map(id => ({ media_fbid: id }));
    ({ id: postId } = await post(`${page}/feed`, { message, attached_media: fotos }));
  } else {
    const r = await post(`${page}/photos`, { url: pub.imagenes[0], message, published: 'true' });
    postId = r.post_id || r.id;
  }

  // Igual que en Instagram, el link es un extra: si falla, el posteo ya salió.
  const permalink = pub.tipo === 'historia' ? null
    : await graph(fetchImpl, 'GET', postId, { fields: 'permalink_url' }, token)
      .then(d => d.permalink_url || null)
      .catch(() => null);
  return { postId, permalink };
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
  GRAPH, SCOPES, TIPOS, REDES, MAX_CAPTION,
  armarPublicacion, normalizarImagenes, normalizarRedes, publicar, publicarFacebook, elegirCuenta, graph,
};
