// Publicar en Facebook e Instagram por Graph API (mcp/meta/_meta.js).
//
// No sale a internet: el fetch es un doble que anota cada llamada y contesta lo que Meta
// contestaría. Lo que se protege es lo que falla en silencio o cuesta caro:
//   - cada tipo de posteo va al endpoint que corresponde, con los parámetros que Meta espera;
//   - Instagram no publica un contenedor antes de que termine de procesarse;
//   - lo que Instagram va a rechazar (30+ hashtags, 11 fotos) se corta antes de gastar una
//     llamada de las 100 diarias;
//   - una fecha sin zona horaria no se programa 3 horas corrida;
//   - el token nunca aparece en un mensaje de error.

const { test } = require('node:test');
const assert = require('node:assert');
const meta = require('../mcp/meta/_meta');

const TOKEN = 'TOKEN-SECRETO-123';

/** Doble de Graph: `rutas` mapea "METODO ruta" a una respuesta (objeto o función de params). */
function fakeGraph(rutas) {
  const llamadas = [];
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url);
    const metodo = opts.method || 'GET';
    const params = Object.fromEntries(metodo === 'GET' ? u.searchParams : opts.body);
    const ruta = u.pathname.replace(/^\/v[\d.]+\//, '');
    llamadas.push({ metodo, ruta, params });
    let r = rutas[`${metodo} ${ruta}`];
    if (typeof r === 'function') r = r(params, llamadas);
    if (r === undefined) r = { error: { message: `ruta no simulada: ${metodo} ${ruta}`, code: 100 } };
    const status = r.error ? 400 : 200;
    return { ok: status === 200, status, json: async () => r };
  }
  return { fetchImpl, llamadas };
}

function deps(rutas, extra = {}) {
  const g = fakeGraph(rutas);
  return {
    g,
    deps: {
      cliente: meta.crearCliente({ token: TOKEN, fetchImpl: g.fetchImpl }),
      cfg: { pageId: 'PAGE', igUserId: 'IG', ...extra.cfg },
      esperar: async () => {},
      resolver: extra.resolver,
      ahoraMs: Date.parse('2026-11-05T12:00:00Z'),
    },
  };
}

const posts = (g, ruta) => g.llamadas.filter(c => c.metodo === 'POST' && (!ruta || c.ruta === ruta));

test('Facebook: una foto va a /photos con el texto, publicada', async () => {
  const { g, deps: d } = deps({
    'POST PAGE/photos': { id: 'F1', post_id: 'PAGE_P1' },
    'GET PAGE_P1': { permalink_url: 'https://fb.com/p1' },
  });
  const r = await meta.publicarFacebook({ mensaje: 'Hola', medios: ['https://x.com/a.jpg'] }, d);
  assert.deepStrictEqual(posts(g)[0].params, {
    url: 'https://x.com/a.jpg', message: 'Hola', published: 'true', access_token: TOKEN,
  });
  assert.strictEqual(r.id, 'PAGE_P1');
  assert.strictEqual(r.permalink, 'https://fb.com/p1');
});

test('Facebook: varias fotos se suben sin publicar y se adjuntan a un solo posteo', async () => {
  let n = 0;
  const { g, deps: d } = deps({
    'POST PAGE/photos': () => ({ id: `F${++n}` }),
    'POST PAGE/feed': { id: 'PAGE_P2' },
    'GET PAGE_P2': { permalink_url: 'https://fb.com/p2' },
  });
  await meta.publicarFacebook({ mensaje: 'Combo', medios: ['https://x.com/a.jpg', 'https://x.com/b.jpg'] }, d);
  const fotos = posts(g, 'PAGE/photos');
  assert.strictEqual(fotos.length, 2);
  assert.ok(fotos.every(f => f.params.published === 'false'));
  const feed = posts(g, 'PAGE/feed')[0].params;
  assert.deepStrictEqual(JSON.parse(feed.attached_media), [{ media_fbid: 'F1' }, { media_fbid: 'F2' }]);
  assert.strictEqual(feed.message, 'Combo');
});

test('Facebook: programar exige zona horaria y manda published=false con la hora exacta', async () => {
  const { g, deps: d } = deps({ 'POST PAGE/feed': { id: 'PAGE_P3' } });
  await assert.rejects(
    meta.publicarFacebook({ mensaje: 'x', programar: '2026-11-06T10:00:00' }, d),
    /zona horaria/,
  );
  const r = await meta.publicarFacebook({ mensaje: 'x', programar: '2026-11-06T10:00:00-03:00' }, d);
  const p = posts(g, 'PAGE/feed')[0].params;
  assert.strictEqual(p.published, 'false');
  assert.strictEqual(Number(p.scheduled_publish_time), Date.parse('2026-11-06T13:00:00Z') / 1000);
  assert.strictEqual(r.programado, '2026-11-06T13:00:00.000Z');
  assert.strictEqual(r.permalink, null);
});

test('Facebook: programar a menos de 10 minutos se rechaza sin llamar a Meta', async () => {
  const { g, deps: d } = deps({});
  await assert.rejects(
    meta.publicarFacebook({ mensaje: 'x', programar: '2026-11-05T12:05:00Z' }, d),
    /10 minutos/,
  );
  assert.strictEqual(g.llamadas.length, 0);
});

test('Facebook: link y fotos juntos se rechazan', async () => {
  const { deps: d } = deps({});
  await assert.rejects(
    meta.publicarFacebook({ link: 'https://tienda.com', medios: ['https://x.com/a.jpg'] }, d),
    /link con fotos/,
  );
});

test('Instagram: una foto crea el contenedor, espera FINISHED y recién ahí publica', async () => {
  let consultas = 0;
  const { g, deps: d } = deps({
    'POST IG/media': { id: 'C1' },
    'GET C1': () => ({ status_code: ++consultas < 3 ? 'IN_PROGRESS' : 'FINISHED' }),
    'POST IG/media_publish': { id: 'M1' },
    'GET M1': { permalink: 'https://instagram.com/p/abc' },
  });
  const r = await meta.publicarInstagram({ caption: 'Nuevo #led', medios: ['https://x.com/a.jpg'] }, d);
  assert.deepStrictEqual(posts(g, 'IG/media')[0].params, {
    image_url: 'https://x.com/a.jpg', caption: 'Nuevo #led', access_token: TOKEN,
  });
  assert.strictEqual(consultas, 3);
  const orden = g.llamadas.map(c => `${c.metodo} ${c.ruta}`);
  assert.ok(orden.lastIndexOf('GET C1') < orden.indexOf('POST IG/media_publish'));
  assert.strictEqual(posts(g, 'IG/media_publish')[0].params.creation_id, 'C1');
  assert.strictEqual(r.permalink, 'https://instagram.com/p/abc');
});

test('Instagram: carrusel crea hijos marcados y un contenedor CAROUSEL con sus ids', async () => {
  let n = 0;
  const { g, deps: d } = deps({
    'POST IG/media': p => ({ id: p.media_type === 'CAROUSEL' ? 'CAR' : `H${++n}` }),
    'GET H1': { status_code: 'FINISHED' },
    'GET H2': { status_code: 'FINISHED' },
    'GET CAR': { status_code: 'FINISHED' },
    'POST IG/media_publish': { id: 'M2' },
    'GET M2': { permalink: 'https://instagram.com/p/car' },
  });
  await meta.publicarInstagram({ caption: 'Dos', medios: ['https://x.com/a.jpg', 'https://x.com/b.mp4'] }, d);
  const [h1, h2, car] = posts(g, 'IG/media').map(c => c.params);
  assert.strictEqual(h1.is_carousel_item, 'true');
  assert.strictEqual(h1.image_url, 'https://x.com/a.jpg');
  assert.strictEqual(h2.media_type, 'VIDEO');
  assert.strictEqual(h2.video_url, 'https://x.com/b.mp4');
  assert.strictEqual(car.media_type, 'CAROUSEL');
  assert.strictEqual(car.children, 'H1,H2');
  assert.strictEqual(car.caption, 'Dos');
  assert.strictEqual(posts(g, 'IG/media_publish')[0].params.creation_id, 'CAR');
});

test('Instagram: un video suelto en el feed sale como reel', async () => {
  const { g, deps: d } = deps({
    'POST IG/media': { id: 'R1' },
    'GET R1': { status_code: 'FINISHED' },
    'POST IG/media_publish': { id: 'M3' },
    'GET M3': { permalink: null },
  });
  const r = await meta.publicarInstagram({ caption: 'Mirá', medios: ['https://x.com/v.mp4?x=1'] }, d);
  assert.strictEqual(posts(g, 'IG/media')[0].params.media_type, 'REELS');
  assert.match(r.avisos.join(' '), /reel/);
});

test('Instagram: si el contenedor da ERROR no se publica', async () => {
  const { g, deps: d } = deps({
    'POST IG/media': { id: 'C9' },
    'GET C9': { status_code: 'ERROR', status: 'Error: formato no soportado' },
  });
  await assert.rejects(
    meta.publicarInstagram({ medios: ['https://x.com/a.jpg'] }, d),
    e => /ERROR/.test(e.message) && e.contenedor === 'C9',
  );
  assert.strictEqual(posts(g, 'IG/media_publish').length, 0);
});

test('Instagram: lo que se va a rechazar se corta antes de llamar a Meta', async () => {
  const { g, deps: d } = deps({});
  const hashtags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
  await assert.rejects(meta.publicarInstagram({ caption: hashtags, medios: ['https://x.com/a.jpg'] }, d), /31 hashtags/);
  const once = Array.from({ length: 11 }, (_, i) => `https://x.com/${i}.jpg`);
  await assert.rejects(meta.publicarInstagram({ medios: once }, d), /hasta 10/);
  await assert.rejects(meta.publicarInstagram({ tipo: 'reel', medios: ['https://x.com/a.jpg'] }, d), /video/);
  assert.strictEqual(g.llamadas.filter(c => c.metodo === 'POST').length, 0);
});

test('Instagram: sin META_IG_USER_ID lo busca en la página', async () => {
  const { g, deps: d } = deps({
    'GET PAGE': { instagram_business_account: { id: 'IG2' } },
    'POST IG2/media': { id: 'C2' },
    'GET C2': { status_code: 'FINISHED' },
    'POST IG2/media_publish': { id: 'M4' },
    'GET M4': { permalink: 'x' },
  }, { cfg: { igUserId: null } });
  await meta.publicarInstagram({ medios: ['https://x.com/a.jpg'] }, d);
  assert.strictEqual(posts(g, 'IG2/media_publish').length, 1);
});

test('archivos locales pasan por el resolver y se publica la URL que devuelve', async () => {
  const subidos = [];
  const { g, deps: d } = deps({
    'POST PAGE/photos': { id: 'F1', post_id: 'P' },
    'GET P': { permalink_url: 'x' },
  }, { resolver: async ruta => { subidos.push(ruta); return 'https://sb.co/redes/foto.jpg'; } });
  const r = await meta.publicarFacebook({ medios: ['./fotos/foto.jpg'] }, d);
  assert.deepStrictEqual(subidos, ['./fotos/foto.jpg']);
  assert.strictEqual(posts(g)[0].params.url, 'https://sb.co/redes/foto.jpg');
  assert.deepStrictEqual(r.archivos_subidos, [{ archivo: './fotos/foto.jpg', url: 'https://sb.co/redes/foto.jpg' }]);
});

test('un token vencido se explica y el token no aparece en el error', async () => {
  const { deps: d } = deps({
    'POST PAGE/feed': { error: { message: 'Error validating access token', code: 190 } },
  });
  await assert.rejects(meta.publicarFacebook({ mensaje: 'x' }, d), e => {
    assert.match(e.message, /venció/);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
});

test('sin token, crearCliente dice qué falta', () => {
  assert.throws(() => meta.crearCliente({ token: '' }), /META_PAGE_ACCESS_TOKEN/);
});
