// mcp/meta/_meta.js
// Publicar en la página de Facebook y en la cuenta de Instagram del negocio, por Graph API.
//
// Meta Business Suite no tiene una API propia: lo que hace por atrás es Graph API, con el
// token de la página. Instagram cuelga de esa página (la cuenta profesional vinculada), así
// que con un solo token de página se publica en los dos lados.
//
// Acá vive todo lo que se puede equivocar: qué endpoint corresponde a cada tipo de posteo,
// las reglas de Instagram que conviene chequear antes de gastar una llamada, y la espera de
// los contenedores. server.js sólo lo expone como herramientas MCP. El fetch, la espera y la
// subida de archivos se inyectan, para que los tests no salgan a internet.

const GRAPH_VERSION_DEFAULT = 'v24.0';

const LIMITES = {
  captionIG: 2200,
  hashtagsIG: 30,
  mencionesIG: 20,
  carruselMin: 2,
  carruselMax: 10,
  // Facebook rechaza un posteo programado a menos de 10 minutos.
  programarMinSeg: 10 * 60,
};

const EXT_VIDEO = new Set(['.mp4', '.mov', '.m4v']);

class ErrorMeta extends Error {
  constructor(mensaje, extra = {}) {
    super(mensaje);
    this.name = 'ErrorMeta';
    Object.assign(this, extra);
  }
}

function configDesdeEnv(env = process.env) {
  return {
    version: env.META_GRAPH_VERSION || GRAPH_VERSION_DEFAULT,
    pageId: env.META_PAGE_ID || null,
    pageToken: env.META_PAGE_ACCESS_TOKEN || null,
    igUserId: env.META_IG_USER_ID || null,
  };
}

// Los errores de Graph vienen en inglés y con códigos. Los que aparecen siempre al
// configurar esto tienen una causa concreta y un arreglo concreto: eso es lo que se devuelve.
// Nunca se incluye la URL del pedido, porque lleva el token.
function explicarErrorGraph(err, status) {
  if (!err) return `Meta respondió ${status || 'sin datos'} y no mandó detalle del error.`;
  const base = err.error_user_msg || err.message || 'Error sin mensaje';
  const code = Number(err.code);
  const sub = Number(err.error_subcode);
  let pista = '';
  if (code === 190) {
    pista = 'El token de la página es inválido o venció. Generá uno nuevo con `node mcp/meta/obtener-token.js`.';
  } else if (code === 10 || code === 200 || (code >= 200 && code < 300)) {
    pista = 'Al token le falta un permiso. Necesita pages_manage_posts, pages_read_engagement, '
      + 'instagram_basic e instagram_content_publish.';
  } else if (code === 4 || code === 17 || code === 32 || code === 613) {
    pista = 'Límite de llamadas de Meta. Esperá unos minutos y probá de nuevo.';
  } else if (code === 9004 || sub === 2207052 || sub === 2207026) {
    pista = 'Meta no pudo bajar el archivo. La URL tiene que ser pública (sin login) y, para '
      + 'Instagram, la imagen tiene que ser JPG.';
  } else if (code === 9 || sub === 2207042) {
    pista = 'Se alcanzó el límite de publicaciones por API de Instagram (100 en 24 h).';
  } else if (code === 100 && /scheduled_publish_time/i.test(base)) {
    pista = 'La fecha de programación tiene que estar entre 10 minutos y 75 días en el futuro.';
  }
  return pista ? `${base} — ${pista}` : base;
}

function crearCliente({ version = GRAPH_VERSION_DEFAULT, token, fetchImpl = fetch }) {
  if (!token) {
    throw new ErrorMeta('Falta META_PAGE_ACCESS_TOKEN. Mirá mcp/meta/README.md para sacarlo.');
  }
  const base = `https://graph.facebook.com/${version}`;

  async function llamar(metodo, ruta, params = {}) {
    const url = new URL(`${base}/${String(ruta).replace(/^\//, '')}`);
    const cuerpo = new URLSearchParams();
    const destino = metodo === 'GET' ? url.searchParams : cuerpo;
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      destino.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    destino.set('access_token', token);

    let res;
    try {
      res = await fetchImpl(url, metodo === 'GET' ? { method: 'GET' } : { method: metodo, body: cuerpo });
    } catch (e) {
      throw new ErrorMeta(`No se pudo conectar con graph.facebook.com (${e.code || e.message}).`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* respuesta sin JSON */ }
    if (!res.ok || data?.error) {
      throw new ErrorMeta(explicarErrorGraph(data?.error, res.status), {
        code: data?.error?.code,
        subcode: data?.error?.error_subcode,
      });
    }
    return data;
  }

  return {
    get: (ruta, params) => llamar('GET', ruta, params),
    post: (ruta, params) => llamar('POST', ruta, params),
  };
}

// ---------------------------------------------------------------------------
// Reglas que se chequean antes de llamar a Meta
// ---------------------------------------------------------------------------

function esUrl(ref) {
  return /^https?:\/\//i.test(String(ref || ''));
}

function tipoDeMedio(ref) {
  const limpio = String(ref || '').split(/[?#]/)[0].toLowerCase();
  const ext = limpio.slice(limpio.lastIndexOf('.'));
  return EXT_VIDEO.has(ext) ? 'video' : 'imagen';
}

function validarCaptionIG(texto) {
  const t = String(texto || '');
  const errores = [];
  if (t.length > LIMITES.captionIG) {
    errores.push(`El texto tiene ${t.length} caracteres; Instagram acepta hasta ${LIMITES.captionIG}.`);
  }
  const hashtags = t.match(/#[\p{L}\p{N}_]+/gu) || [];
  if (hashtags.length > LIMITES.hashtagsIG) {
    errores.push(`Tiene ${hashtags.length} hashtags; Instagram acepta hasta ${LIMITES.hashtagsIG}.`);
  }
  const menciones = t.match(/(^|[^\w@])@[\w.]+/g) || [];
  if (menciones.length > LIMITES.mencionesIG) {
    errores.push(`Tiene ${menciones.length} menciones; Instagram acepta hasta ${LIMITES.mencionesIG}.`);
  }
  return errores;
}

// La fecha tiene que traer la zona horaria. Sin ella, "2026-11-06T10:00" se interpretaría
// en la hora del proceso (UTC en un servidor) y el posteo saldría 3 horas antes de lo pedido.
function segundosProgramado(fecha, ahoraMs = Date.now()) {
  const texto = String(fecha || '').trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(texto)) {
    throw new ErrorMeta(`La fecha "${texto}" no tiene zona horaria. Usá por ejemplo 2026-11-06T10:00:00-03:00.`);
  }
  const ms = Date.parse(texto);
  if (Number.isNaN(ms)) throw new ErrorMeta(`No entiendo la fecha "${texto}".`);
  const seg = Math.floor(ms / 1000);
  if (seg < Math.floor(ahoraMs / 1000) + LIMITES.programarMinSeg) {
    throw new ErrorMeta('Facebook sólo programa posteos con al menos 10 minutos de anticipación.');
  }
  return seg;
}

async function resolverMedios(medios, resolver) {
  const salida = [];
  for (const ref of medios) {
    const tipo = tipoDeMedio(ref);
    if (esUrl(ref)) {
      salida.push({ url: ref, tipo });
    } else {
      if (!resolver) throw new ErrorMeta(`"${ref}" no es una URL y no hay cómo subir archivos locales.`);
      salida.push({ url: await resolver(ref), tipo, local: ref });
    }
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

async function idDePagina(cliente, cfg) {
  if (cfg.pageId) return cfg.pageId;
  // Con un token de página, /me es la página misma.
  const yo = await cliente.get('me', { fields: 'id' });
  cfg.pageId = yo.id;
  return yo.id;
}

async function publicarFacebook({ mensaje, link, medios = [], programar } = {}, deps) {
  const { cliente, cfg, resolver, ahoraMs } = deps;
  if (!mensaje && !link && medios.length === 0) {
    throw new ErrorMeta('El posteo de Facebook necesita texto, un link o al menos una foto/video.');
  }
  if (link && medios.length) {
    throw new ErrorMeta('Facebook no deja combinar un link con fotos en el mismo posteo. Elegí uno.');
  }
  const archivos = await resolverMedios(medios, resolver);
  const videos = archivos.filter(a => a.tipo === 'video');
  if (videos.length && archivos.length > 1) {
    throw new ErrorMeta('Un posteo de Facebook con video lleva un solo video y nada más.');
  }

  const pageId = await idDePagina(cliente, cfg);
  const cuando = programar ? segundosProgramado(programar, ahoraMs) : undefined;
  const publicacion = cuando
    ? { published: false, scheduled_publish_time: cuando }
    : { published: true };

  let id;
  if (videos.length) {
    const r = await cliente.post(`${pageId}/videos`, { file_url: videos[0].url, description: mensaje, ...publicacion });
    id = r.id;
  } else if (archivos.length === 1) {
    const r = await cliente.post(`${pageId}/photos`, { url: archivos[0].url, message: mensaje, ...publicacion });
    id = r.post_id || r.id;
  } else if (archivos.length > 1) {
    // Varias fotos: se suben sin publicar y después se adjuntan a un único posteo.
    const fotos = [];
    for (const a of archivos) {
      const r = await cliente.post(`${pageId}/photos`, {
        url: a.url,
        published: false,
        temporary: cuando ? true : undefined,
      });
      fotos.push({ media_fbid: r.id });
    }
    const r = await cliente.post(`${pageId}/feed`, { message: mensaje, attached_media: fotos, ...publicacion });
    id = r.id;
  } else {
    const r = await cliente.post(`${pageId}/feed`, { message: mensaje, link, ...publicacion });
    id = r.id;
  }

  let permalink = null;
  if (!cuando) {
    try {
      permalink = (await cliente.get(id, { fields: 'permalink_url' })).permalink_url || null;
    } catch { /* el posteo ya salió; el link es un extra */ }
  }
  return {
    plataforma: 'facebook',
    id,
    permalink,
    programado: cuando ? new Date(cuando * 1000).toISOString() : null,
    archivos_subidos: archivos.filter(a => a.local).map(a => ({ archivo: a.local, url: a.url })),
  };
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

async function idDeInstagram(cliente, cfg) {
  if (cfg.igUserId) return cfg.igUserId;
  const pageId = await idDePagina(cliente, cfg);
  const p = await cliente.get(pageId, { fields: 'instagram_business_account' });
  const id = p.instagram_business_account?.id;
  if (!id) {
    throw new ErrorMeta('La página no tiene una cuenta de Instagram profesional vinculada. '
      + 'Vinculala desde Meta Business Suite → Configuración → Cuentas de Instagram.');
  }
  cfg.igUserId = id;
  return id;
}

// Instagram procesa cada contenedor en segundo plano (los videos tardan). Publicar antes de
// que esté FINISHED devuelve error, así que se espera.
async function esperarContenedor(cliente, id, { esperar, intentos = 60, intervaloMs = 5000 } = {}) {
  for (let i = 0; i < intentos; i++) {
    const r = await cliente.get(id, { fields: 'status_code,status' });
    if (r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED') return r.status_code;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      throw new ErrorMeta(`Instagram no pudo procesar el archivo (${r.status_code}: ${r.status || 'sin detalle'}).`, {
        contenedor: id,
      });
    }
    await esperar(intervaloMs);
  }
  throw new ErrorMeta(`Instagram sigue procesando el contenedor ${id}. Probá en unos minutos con instagram_estado.`, {
    contenedor: id,
    pendiente: true,
  });
}

function paramsMedio(archivo) {
  return archivo.tipo === 'video'
    ? { media_type: 'VIDEO', video_url: archivo.url }
    : { image_url: archivo.url };
}

async function publicarContenedor(cliente, igId, contenedor) {
  const r = await cliente.post(`${igId}/media_publish`, { creation_id: contenedor });
  let permalink = null;
  try {
    permalink = (await cliente.get(r.id, { fields: 'permalink' })).permalink || null;
  } catch { /* ya está publicado */ }
  return { id: r.id, permalink };
}

async function publicarInstagram({ caption, medios = [], tipo = 'feed', compartirEnFeed = true } = {}, deps) {
  const { cliente, cfg, resolver, esperar } = deps;
  const errores = validarCaptionIG(caption);
  if (errores.length) throw new ErrorMeta(errores.join(' '));
  if (medios.length === 0) throw new ErrorMeta('Instagram necesita al menos una foto o video.');
  if (!['feed', 'reel', 'story'].includes(tipo)) throw new ErrorMeta(`Tipo "${tipo}" desconocido: feed, reel o story.`);
  if ((tipo === 'reel' || tipo === 'story') && medios.length !== 1) {
    throw new ErrorMeta(`Un ${tipo} lleva un solo archivo.`);
  }
  if (medios.length > LIMITES.carruselMax) {
    throw new ErrorMeta(`Un carrusel acepta hasta ${LIMITES.carruselMax} archivos; mandaste ${medios.length}.`);
  }

  const archivos = await resolverMedios(medios, resolver);
  const avisos = [];
  const igId = await idDeInstagram(cliente, cfg);
  const espera = { esperar };

  let contenedor;
  if (tipo === 'story') {
    if (caption) avisos.push('Las historias no llevan texto por API: el texto se ignoró.');
    const a = archivos[0];
    const r = await cliente.post(`${igId}/media`, {
      media_type: 'STORIES',
      ...(a.tipo === 'video' ? { video_url: a.url } : { image_url: a.url }),
    });
    contenedor = r.id;
  } else if (archivos.length === 1 && (tipo === 'reel' || archivos[0].tipo === 'video')) {
    if (archivos[0].tipo !== 'video') throw new ErrorMeta('Un reel tiene que ser un video (.mp4 o .mov).');
    if (tipo === 'feed') avisos.push('Instagram publica los videos sueltos como reel.');
    const r = await cliente.post(`${igId}/media`, {
      media_type: 'REELS',
      video_url: archivos[0].url,
      caption,
      share_to_feed: compartirEnFeed,
    });
    contenedor = r.id;
  } else if (archivos.length === 1) {
    const r = await cliente.post(`${igId}/media`, { image_url: archivos[0].url, caption });
    contenedor = r.id;
  } else {
    const hijos = [];
    for (const a of archivos) {
      const r = await cliente.post(`${igId}/media`, { ...paramsMedio(a), is_carousel_item: true });
      hijos.push(r.id);
    }
    for (const h of hijos) await esperarContenedor(cliente, h, espera);
    const r = await cliente.post(`${igId}/media`, { media_type: 'CAROUSEL', children: hijos.join(','), caption });
    contenedor = r.id;
  }

  await esperarContenedor(cliente, contenedor, espera);
  const publicado = await publicarContenedor(cliente, igId, contenedor);
  return {
    plataforma: 'instagram',
    tipo,
    ...publicado,
    avisos,
    archivos_subidos: archivos.filter(a => a.local).map(a => ({ archivo: a.local, url: a.url })),
  };
}

// Para un contenedor que quedó procesando (un reel largo): si ya terminó, lo publica.
async function finalizarInstagram({ contenedor }, deps) {
  const { cliente, cfg, esperar } = deps;
  const igId = await idDeInstagram(cliente, cfg);
  await esperarContenedor(cliente, contenedor, { esperar, intentos: 1 });
  return { plataforma: 'instagram', ...(await publicarContenedor(cliente, igId, contenedor)) };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

async function cuentas(deps) {
  const { cliente, cfg } = deps;
  const pageId = await idDePagina(cliente, cfg);
  const p = await cliente.get(pageId, {
    fields: 'id,name,link,followers_count,instagram_business_account{id,username,name,followers_count}',
  });
  const salida = {
    facebook: { id: p.id, nombre: p.name, link: p.link || null, seguidores: p.followers_count ?? null },
    instagram: null,
  };
  const ig = p.instagram_business_account;
  if (ig) {
    cfg.igUserId = cfg.igUserId || ig.id;
    salida.instagram = { id: ig.id, usuario: ig.username, nombre: ig.name || null, seguidores: ig.followers_count ?? null };
    try {
      const lim = await cliente.get(`${ig.id}/content_publishing_limit`, { fields: 'quota_usage,config' });
      const d = lim.data?.[0];
      if (d) salida.instagram.publicaciones_24h = { usadas: d.quota_usage, maximo: d.config?.quota_total ?? null };
    } catch { /* dato opcional */ }
  }
  return salida;
}

async function recientes({ plataforma = 'ambas', cantidad = 5 } = {}, deps) {
  const { cliente, cfg } = deps;
  const n = Math.min(Math.max(Number(cantidad) || 5, 1), 25);
  const salida = {};
  if (plataforma !== 'instagram') {
    const pageId = await idDePagina(cliente, cfg);
    const r = await cliente.get(`${pageId}/posts`, { fields: 'id,message,created_time,permalink_url', limit: n });
    salida.facebook = (r.data || []).map(x => ({
      id: x.id, fecha: x.created_time, texto: x.message || '', link: x.permalink_url || null,
    }));
  }
  if (plataforma !== 'facebook') {
    const igId = await idDeInstagram(cliente, cfg);
    const r = await cliente.get(`${igId}/media`, { fields: 'id,caption,media_type,permalink,timestamp', limit: n });
    salida.instagram = (r.data || []).map(x => ({
      id: x.id, fecha: x.timestamp, tipo: x.media_type, texto: x.caption || '', link: x.permalink || null,
    }));
  }
  return salida;
}

module.exports = {
  GRAPH_VERSION_DEFAULT,
  LIMITES,
  ErrorMeta,
  configDesdeEnv,
  explicarErrorGraph,
  crearCliente,
  esUrl,
  tipoDeMedio,
  validarCaptionIG,
  segundosProgramado,
  publicarFacebook,
  publicarInstagram,
  finalizarInstagram,
  esperarContenedor,
  cuentas,
  recientes,
};
