// Publicación en Instagram y Facebook: la validación de lo que se programa, la secuencia de
// llamadas a la Graph API de Meta y la toma de filas que evita publicar dos veces lo mismo.
//
// Sin navegador: api/_metaInstagram.js y publicarFila (api/cron/instagram-publicar.js) se
// ejercitan directo, con un fetch y un Supabase de mentira.

const { test } = require('node:test');
const assert = require('node:assert');
const { armarPublicacion, normalizarRedes, publicar, publicarFacebook, elegirCuenta } = require('../api/_metaInstagram');
const { publicarFila } = require('../api/cron/instagram-publicar');

const AHORA = new Date('2026-11-05T12:00:00Z');
const URL1 = 'https://cdn.example.com/1.jpg';
const URL2 = 'https://cdn.example.com/2.jpg';
const base = { tipo: 'carrusel', imagenes: [URL1, URL2], caption: 'Hola', programadoPara: '2026-11-05T23:00:00Z' };

test('un carrusel válido queda listo para guardar', () => {
  const { publicacion, error } = armarPublicacion({ ...base, notas: '  semana 1 ' }, AHORA);
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(publicacion, {
    tipo: 'carrusel', redes: ['instagram', 'facebook'], imagenes: [URL1, URL2], caption: 'Hola',
    programado_para: '2026-11-05T23:00:00.000Z', notas: 'semana 1',
  });
});

test('las redes: sin indicar sale en las dos; se puede elegir una sola', () => {
  assert.deepStrictEqual(normalizarRedes(undefined).redes, ['instagram', 'facebook']);
  assert.deepStrictEqual(normalizarRedes(['Facebook']).redes, ['facebook']);
  assert.deepStrictEqual(normalizarRedes('facebook, instagram').redes, ['instagram', 'facebook']);
  assert.match(armarPublicacion({ ...base, redes: [] }, AHORA).error, /al menos una red/);
  assert.match(armarPublicacion({ ...base, redes: ['tiktok'] }, AHORA).error, /Red desconocida/);
  assert.deepStrictEqual(armarPublicacion({ ...base, redes: ['instagram'] }, AHORA).publicacion.redes, ['instagram']);
});

test('las imágenes pueden venir como texto, una por línea (el formulario del CRM)', () => {
  const { publicacion } = armarPublicacion({ ...base, imagenes: `${URL1}\n\n  ${URL2}  \n` }, AHORA);
  assert.deepStrictEqual(publicacion.imagenes, [URL1, URL2]);
});

test('cantidad de imágenes según el tipo', () => {
  assert.match(armarPublicacion({ ...base, imagenes: [URL1] }, AHORA).error, /de 2 a 10/);
  assert.match(armarPublicacion({ ...base, imagenes: Array(11).fill(URL1) }, AHORA).error, /de 2 a 10/);
  assert.match(armarPublicacion({ ...base, tipo: 'post' }, AHORA).error, /una sola imagen/);
  assert.match(armarPublicacion({ ...base, tipo: 'historia' }, AHORA).error, /una sola imagen/);
  assert.match(armarPublicacion({ ...base, imagenes: [] }, AHORA).error, /al menos una imagen/);
});

test('solo URLs públicas https', () => {
  assert.match(armarPublicacion({ ...base, imagenes: [URL1, 'http://x.com/2.jpg'] }, AHORA).error, /https/);
  assert.match(armarPublicacion({ ...base, imagenes: [URL1, '/tmp/2.jpg'] }, AHORA).error, /https/);
});

test('tipo, texto y fecha', () => {
  assert.match(armarPublicacion({ ...base, tipo: 'reel' }, AHORA).error, /tipo/);
  assert.match(armarPublicacion({ ...base, caption: 'x'.repeat(2201) }, AHORA).error, /2201 caracteres/);
  assert.match(armarPublicacion({ ...base, caption: Array(31).fill('#moto').join(' ') }, AHORA).error, /hashtags/);
  assert.match(armarPublicacion({ ...base, programadoPara: '' }, AHORA).error, /fecha/);
  // Una hora atrás es un error de fecha; dos minutos atrás se acepta y sale en la próxima vuelta.
  assert.match(armarPublicacion({ ...base, programadoPara: '2026-11-05T11:00:00Z' }, AHORA).error, /ya pasó/);
  assert.strictEqual(armarPublicacion({ ...base, programadoPara: '2026-11-05T11:58:00Z' }, AHORA).error, undefined);
});

test('la historia descarta el texto: Meta no lo acepta por API', () => {
  const { publicacion } = armarPublicacion({ ...base, tipo: 'historia', imagenes: [URL1] }, AHORA);
  assert.strictEqual(publicacion.caption, null);
});

// fetch de mentira: registra cada llamada y responde según la ruta.
function fakeGraph({ estadoContenedor = 'FINISHED', facebookFalla = false } = {}) {
  const llamadas = [];
  let n = 0;
  let fotos = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const params = Object.fromEntries(opts.body ? new URLSearchParams(opts.body) : u.searchParams);
    const ruta = u.pathname.replace(/^\/v[\d.]+\//, '');
    llamadas.push({ metodo: opts.method || 'GET', ruta, params });
    if (facebookFalla && ruta.startsWith('PAGE1/')) {
      return { ok: false, status: 403, json: async () => ({ error: { message: 'Falta el permiso pages_manage_posts' } }) };
    }
    let data;
    if (ruta.endsWith('/media')) data = { id: `cont${++n}` };
    else if (ruta.endsWith('/media_publish')) data = { id: 'media99' };
    else if (ruta.endsWith('/photos')) data = { id: `foto${++fotos}`, post_id: `PAGE1_foto${fotos}` };
    else if (ruta.endsWith('/feed')) data = { id: 'PAGE1_feed1' };
    else if (ruta.endsWith('/photo_stories')) data = { success: true, post_id: 'story1' };
    else if (params.fields === 'status_code,status') data = { status_code: estadoContenedor };
    else if (params.fields === 'permalink') data = { permalink: 'https://instagram.com/p/abc' };
    else if (params.fields === 'permalink_url') data = { permalink_url: 'https://facebook.com/martinezmotos/posts/1' };
    return { ok: true, status: 200, json: async () => data };
  };
  return { fetchImpl, llamadas };
}

const CUENTA = { ig_user_id: 'IG1', page_id: 'PAGE1', page_access_token: 'TOKEN' };
const espera = { intentos: 2, cadaMs: 0 };

test('un carrusel crea los hijos, el padre con el texto y recién después publica', async () => {
  const { fetchImpl, llamadas } = fakeGraph();
  const r = await publicar({ tipo: 'carrusel', imagenes: [URL1, URL2], caption: 'Hola' }, CUENTA, { fetchImpl, espera });
  assert.deepStrictEqual(r, { mediaId: 'media99', permalink: 'https://instagram.com/p/abc' });

  const posts = llamadas.filter(l => l.metodo === 'POST');
  assert.deepStrictEqual(posts.map(l => l.ruta), ['IG1/media', 'IG1/media', 'IG1/media', 'IG1/media_publish']);
  assert.deepStrictEqual(posts[0].params, { image_url: URL1, is_carousel_item: 'true', access_token: 'TOKEN' });
  assert.deepStrictEqual(posts[2].params, { media_type: 'CAROUSEL', children: 'cont1,cont2', caption: 'Hola', access_token: 'TOKEN' });
  assert.deepStrictEqual(posts[3].params, { creation_id: 'cont3', access_token: 'TOKEN' });
  // Cada contenedor se espera antes de seguir: los dos hijos y el padre.
  assert.strictEqual(llamadas.filter(l => l.params.fields === 'status_code,status').length, 3);
});

test('una historia va como STORIES y sin texto', async () => {
  const { fetchImpl, llamadas } = fakeGraph();
  await publicar({ tipo: 'historia', imagenes: [URL1], caption: null }, CUENTA, { fetchImpl, espera });
  assert.deepStrictEqual(llamadas[0].params, { media_type: 'STORIES', image_url: URL1, access_token: 'TOKEN' });
});

test('si Meta no puede procesar la imagen no se publica', async () => {
  const { fetchImpl, llamadas } = fakeGraph({ estadoContenedor: 'ERROR' });
  await assert.rejects(
    publicar({ tipo: 'post', imagenes: [URL1], caption: 'x' }, CUENTA, { fetchImpl, espera }),
    /no pudo procesar la imagen/);
  assert.ok(!llamadas.some(l => l.ruta.endsWith('media_publish')));
});

test('sin cuenta conectada avisa en vez de llamar a Meta', async () => {
  const { fetchImpl, llamadas } = fakeGraph();
  await assert.rejects(publicar({ tipo: 'post', imagenes: [URL1] }, null, { fetchImpl }), /no está conectado/);
  assert.strictEqual(llamadas.length, 0);
});

test('Facebook: un carrusel sube las fotos sin publicar y las adjunta a un solo posteo', async () => {
  const { fetchImpl, llamadas } = fakeGraph();
  const r = await publicarFacebook({ tipo: 'carrusel', imagenes: [URL1, URL2], caption: 'Hola' }, CUENTA, { fetchImpl });
  assert.deepStrictEqual(r, { postId: 'PAGE1_feed1', permalink: 'https://facebook.com/martinezmotos/posts/1' });
  const posts = llamadas.filter(l => l.metodo === 'POST');
  assert.deepStrictEqual(posts.map(l => l.ruta), ['PAGE1/photos', 'PAGE1/photos', 'PAGE1/feed']);
  assert.deepStrictEqual(posts[0].params, { url: URL1, published: 'false', access_token: 'TOKEN' });
  assert.deepStrictEqual(posts[2].params, {
    message: 'Hola',
    'attached_media[0]': '{"media_fbid":"foto1"}',
    'attached_media[1]': '{"media_fbid":"foto2"}',
    access_token: 'TOKEN',
  });
});

test('Facebook: un post es una foto con el texto, y una historia va sin texto ni link', async () => {
  let g = fakeGraph();
  const post = await publicarFacebook({ tipo: 'post', imagenes: [URL1], caption: 'Hola' }, CUENTA, { fetchImpl: g.fetchImpl });
  assert.strictEqual(post.postId, 'PAGE1_foto1');
  assert.deepStrictEqual(g.llamadas[0].params, { url: URL1, message: 'Hola', published: 'true', access_token: 'TOKEN' });

  g = fakeGraph();
  const historia = await publicarFacebook({ tipo: 'historia', imagenes: [URL1], caption: null }, CUENTA, { fetchImpl: g.fetchImpl });
  assert.deepStrictEqual(historia, { postId: 'story1', permalink: null });
  assert.deepStrictEqual(g.llamadas.map(l => l.ruta), ['PAGE1/photos', 'PAGE1/photo_stories']);
  assert.deepStrictEqual(g.llamadas[1].params, { photo_id: 'foto1', access_token: 'TOKEN' });
});

test('Facebook sin página conectada avisa en vez de llamar a Meta', async () => {
  const { fetchImpl, llamadas } = fakeGraph();
  await assert.rejects(publicarFacebook({ tipo: 'post', imagenes: [URL1] }, { page_access_token: 'T' }, { fetchImpl }), /no está conectado/);
  assert.strictEqual(llamadas.length, 0);
});

test('elige la página de la cuenta configurada, o la primera con Instagram', () => {
  const paginas = [
    { id: 'p0', name: 'Sin IG' },
    { id: 'p1', instagram_business_account: { id: 'ig1', username: 'otra' } },
    { id: 'p2', instagram_business_account: { id: 'ig2', username: 'martinezmotos.uy' } },
  ];
  assert.strictEqual(elegirCuenta(paginas, '@MartinezMotos.uy').id, 'p2');
  assert.strictEqual(elegirCuenta(paginas, '').id, 'p1');
  assert.strictEqual(elegirCuenta([{ id: 'p0' }], ''), null);
});

// Supabase de mentira con lo justo que usa publicarFila: update/select con eq e in.
function fakeSupabase(filas, cuenta = CUENTA) {
  const tablas = { instagram_publicaciones: filas, meta_tokens: cuenta ? [{ id: 1, ...cuenta }] : [] };
  return {
    from(tabla) {
      const filtros = [];
      let cambios = null;
      const q = {
        update(c) { cambios = c; return q; },
        select() { return q; },
        eq(k, v) { filtros.push(f => f[k] === v); return q; },
        in(k, vs) { filtros.push(f => vs.includes(f[k])); return q; },
        maybeSingle() { return Promise.resolve({ data: tablas[tabla].find(f => filtros.every(fn => fn(f))) || null, error: null }); },
        then(ok, ko) {
          const hits = tablas[tabla].filter(f => filtros.every(fn => fn(f)));
          if (cambios) hits.forEach(f => Object.assign(f, cambios));
          return Promise.resolve({ data: hits.map(f => ({ ...f })), error: null }).then(ok, ko);
        },
      };
      return q;
    },
  };
}

test('publicarFila marca publicada la fila con el id y el link de Instagram', async () => {
  const fila = { id: 1, tipo: 'post', imagenes: [URL1], caption: 'x', estado: 'programado', intentos: 0 };
  const { fetchImpl } = fakeGraph();
  const r = await publicarFila(fakeSupabase([fila]), 1, { fetchImpl });
  assert.deepStrictEqual(r, {
    ok: true, id: 1, tipo: 'post', redes: ['instagram'], permalink: 'https://instagram.com/p/abc', fbPermalink: null,
  });
  assert.strictEqual(fila.estado, 'publicado');
  assert.strictEqual(fila.ig_media_id, 'media99');
  assert.strictEqual(fila.intentos, 1);
});

test('publicarFila no toma una fila que ya salió o que otro está publicando', async () => {
  for (const estado of ['publicado', 'publicando', 'cancelado']) {
    const { fetchImpl, llamadas } = fakeGraph();
    const r = await publicarFila(fakeSupabase([{ id: 1, tipo: 'post', imagenes: [URL1], estado }]), 1, { fetchImpl });
    assert.strictEqual(r, null, estado);
    assert.strictEqual(llamadas.length, 0, estado);
  }
});

test('un error deja la fila con el mensaje; "sigue procesando" vuelve a la cola', async () => {
  const fila = { id: 1, tipo: 'post', imagenes: [URL1], caption: 'x', estado: 'programado', intentos: 0 };
  const sinCuenta = await publicarFila(fakeSupabase([fila], null), 1, {});
  assert.match(sinCuenta.error, /no está conectado/);
  assert.strictEqual(fila.estado, 'error');

  const fila2 = { id: 2, tipo: 'post', imagenes: [URL1], caption: 'x', estado: 'programado', intentos: 0 };
  const { fetchImpl } = fakeGraph({ estadoContenedor: 'IN_PROGRESS' });
  const r = await publicarFila(fakeSupabase([fila2]), 2, { fetchImpl, espera: { intentos: 1, cadaMs: 0 } });
  assert.strictEqual(r.reintentar, true);
  assert.strictEqual(fila2.estado, 'programado');
  assert.strictEqual(fila2.intentos, 1);
});

test('publicarFila con las dos redes publica en Instagram y en Facebook', async () => {
  const fila = { id: 1, tipo: 'post', redes: ['instagram', 'facebook'], imagenes: [URL1], caption: 'x', estado: 'programado', intentos: 0 };
  const { fetchImpl } = fakeGraph();
  const r = await publicarFila(fakeSupabase([fila]), 1, { fetchImpl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fila.estado, 'publicado');
  assert.strictEqual(fila.ig_media_id, 'media99');
  assert.strictEqual(fila.fb_post_id, 'PAGE1_foto1');
  assert.strictEqual(fila.fb_permalink, 'https://facebook.com/martinezmotos/posts/1');
});

test('si falla una sola red, al reintentar se publica solo en la que faltaba', async () => {
  const fila = { id: 1, tipo: 'post', redes: ['instagram', 'facebook'], imagenes: [URL1], caption: 'x', estado: 'programado', intentos: 0 };
  const sb = fakeSupabase([fila]);

  const primera = await publicarFila(sb, 1, { fetchImpl: fakeGraph({ facebookFalla: true }).fetchImpl });
  assert.deepStrictEqual(primera.fallidas, ['facebook']);
  assert.deepStrictEqual(primera.salieron, ['instagram']);
  assert.strictEqual(fila.estado, 'error');
  assert.match(fila.error, /^Facebook: Falta el permiso/);
  assert.strictEqual(fila.ig_media_id, 'media99');

  const g = fakeGraph();
  const segunda = await publicarFila(sb, 1, { desde: ['programado', 'error'], fetchImpl: g.fetchImpl });
  assert.strictEqual(segunda.ok, true);
  assert.strictEqual(fila.estado, 'publicado');
  // Instagram ya había salido: no se lo vuelve a tocar.
  assert.ok(!g.llamadas.some(l => l.ruta.startsWith('IG1/')));
  assert.strictEqual(fila.fb_post_id, 'PAGE1_foto1');
});
