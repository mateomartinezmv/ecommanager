// El recorrido completo de api/fotos-ia.js contra una Supabase en memoria y con Higgsfield,
// MELI y la IA de texto simulados (sin red). Lo que se protege:
//
//   · Nunca hay más de 4 imágenes generándose a la vez (Higgsfield rechaza el resto).
//   · Un 429 deja la foto en cola sin marcarla con error; un fallo sin respuesta NO se
//     reenvía solo, porque Higgsfield pudo haberla cobrado.
//   · Lo terminado se baja, se le pone el logo y queda guardado en Storage.
//   · Publicar reemplaza las fotos de TODAS las publicaciones del SKU (original y ángulos),
//     con la portada primero, y saltea las que MELI no deja tocar.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sharp = require('sharp');

process.env.HIGGSFIELD_API_KEY = 'KEYID:SECRETO';
process.env.ANTHROPIC_API_KEY = 'test';

// ── Supabase en memoria ──────────────────────────────────────────
let tablas, subidos, seq;
function query(tabla) {
  const st = { op: 'select', filtros: [], orden: null, limite: null, payload: null, count: false, head: false, single: false, maybe: false };
  const b = {
    select(_c, opts = {}) { if (st.op === 'select') { st.count = !!opts.count; st.head = !!opts.head; } return b; },
    insert(p) { st.op = 'insert'; st.payload = [].concat(p); return b; },
    update(p) { st.op = 'update'; st.payload = p; return b; },
    eq(c, v) { st.filtros.push(r => r[c] === v); return b; },
    in(c, vs) { st.filtros.push(r => vs.includes(r[c])); return b; },
    order(c, { ascending = true } = {}) { st.orden = [c, ascending]; return b; },
    limit(n) { st.limite = n; return b; },
    maybeSingle() { st.maybe = true; return b; },
    single() { st.single = true; return b; },
    then(ok, mal) { return Promise.resolve().then(ejecutar).then(ok, mal); },
  };
  function ejecutar() {
    const t = (tablas[tabla] = tablas[tabla] || []);
    const pasa = r => st.filtros.every(f => f(r));
    let data;
    if (st.op === 'insert') {
      data = st.payload.map(p => {
        const r = { id: ++seq, compartida: false, error: null, hf_request_id: null, hf_url: null, url_final: null,
          estado_desde: new Date().toISOString(), created_at: new Date().toISOString(), ...p };
        t.push(r);
        return { ...r };
      });
    } else if (st.op === 'update') {
      data = t.filter(pasa).map(r => ({ ...Object.assign(r, st.payload) }));
    } else {
      data = t.filter(pasa).map(r => ({ ...r }));
      if (st.orden) {
        const [c, asc] = st.orden;
        data.sort((a, x) => (a[c] > x[c] ? 1 : a[c] < x[c] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (st.limite != null) data = data.slice(0, st.limite);
      if (st.count) return { data: st.head ? null : data, count: data.length, error: null };
    }
    if (st.single || st.maybe) return { data: data[0] || null, error: st.single && !data[0] ? { message: 'sin filas' } : null };
    return { data, error: null };
  }
  return b;
}
const supabase = {
  from: query,
  storage: {
    from: bucket => ({
      upload: async (ruta, buffer) => { subidos[ruta] = buffer; return { error: null }; },
      getPublicUrl: ruta => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/${bucket}/${ruta}` } }),
    }),
  },
};

function fijarModulo(rel, exports) {
  const archivo = require.resolve(path.join('..', 'api', rel));
  require.cache[archivo] = { id: archivo, filename: archivo, loaded: true, exports };
}
fijarModulo('_supabase', { getSupabase: () => supabase });
fijarModulo('_meliToken', { getMeliToken: async () => 'TOKEN-MELI' });
const handler = require('../api/fotos-ia');

// ── Red simulada ─────────────────────────────────────────────────
let hf, meli, imagen;
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const metodo = opts.method || 'GET';
  if (u.host === 'api.higgsfield.ai') {
    assert.strictEqual(opts.headers.Authorization, 'Key KEYID:SECRETO');
    if (metodo === 'POST') {
      const cuerpo = JSON.parse(opts.body);
      hf.envios.push({ ruta: u.pathname, cuerpo });
      const forzado = hf.respuestasEnvio.shift();
      if (forzado === 'red') throw new Error('socket hang up');
      if (forzado) return json(forzado, { detail: 'forzado' });
      const id = `00000000-0000-4000-8000-${String(hf.envios.length).padStart(12, '0')}`;
      hf.estados[id] = 'in_progress';
      return json(200, { request_id: id, status: 'queued' });
    }
    const id = u.pathname.split('/')[2];
    const status = hf.estados[id];
    return json(200, { request_id: id, status, ...(status === 'completed' ? { images: [{ url: `https://cdn.hf.test/${id}.png` }] } : {}) });
  }
  if (u.host === 'cdn.hf.test') return new Response(imagen, { status: 200 });
  if (u.host === 'api.anthropic.com') {
    return json(200, { content: [{ type: 'text', text: '```json\n' + JSON.stringify({
      medidas: { titulo: 'MEDIDAS', subtitulo: 'Manillar de aluminio', datos: ['80 cm de largo', 'Ø 22 mm'], destacados: ['ALUMINIO'] },
      compatible: { titulo: 'COMPATIBLE', etiquetas: ['CALLE'], verificaciones: ['Ø 22 mm'], escena: 'en una moto' },
      beneficios: { titulo: '¿POR QUÉ?', items: ['Más control'] },
      instalacion: { titulo: 'INSTALACIÓN', pasos: ['Aflojá', 'Colocá'], escena: '' },
    }) + '\n```' }] });
  }
  if (u.host === 'api.mercadolibre.com') {
    const id = u.pathname.split('/')[2];
    if (u.pathname.endsWith('/description')) return json(200, { plain_text: 'Manillar de 80 cm, 22 mm.' });
    if (metodo === 'PUT') {
      const cuerpo = JSON.parse(opts.body);
      meli.puts.push({ id, cuerpo });
      const it = meli.items[id];
      it.pictures = cuerpo.pictures.map((p, i) => ({ id: p.id || `PIC-${id}-${i}` }));
      return json(200, it);
    }
    return meli.items[id] ? json(200, meli.items[id]) : json(404, { message: 'not_found' });
  }
  throw new Error(`fetch inesperado: ${url}`);
};

async function llamar(metodo, accion, body = {}, query = {}) {
  const r = { status: 200, cuerpo: null };
  const res = {
    status(s) { r.status = s; return res; },
    json(c) { r.cuerpo = c; return res; },
    setHeader() {},
  };
  await handler({ method: metodo, query: { ...(accion ? { accion } : {}), ...query }, body }, res);
  return r;
}

const fila = id => tablas.fotos_ia.find(f => f.id === id);
const porEstado = e => tablas.fotos_ia.filter(f => f.estado === e);

beforeEach(async () => {
  seq = 0;
  subidos = {};
  hf = { envios: [], estados: {}, respuestasEnvio: [] };
  imagen = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  tablas = {
    productos: [
      { sku: 'NEG', nombre: 'Manillar 22mm - Negro', grupo: 'Manillares', subgrupo: 'Universal', meli_id: 'MLU1', meli_ids: ['MLU1', 'MLU2', 'MLUCAT'] },
      { sku: 'ROJ', nombre: 'Manillar 22mm - Rojo', grupo: 'Manillares', subgrupo: 'Universal', meli_id: 'MLU9', meli_ids: ['MLU9'] },
    ],
    fotos_ia: [],
  };
  meli = {
    puts: [],
    items: {
      MLU1: { id: 'MLU1', title: 'Manillar Negro', status: 'active', attributes: [{ id: 'COLOR', value_name: 'Negro' }], pictures: [{ id: 'VIEJA1', secure_url: 'https://m.test/neg1.jpg' }, { id: 'VIEJA2', secure_url: 'https://m.test/neg2.jpg' }] },
      MLU2: { id: 'MLU2', title: 'Manubrio Negro', status: 'active', pictures: [{ id: 'VIEJA1' }] },
      MLUCAT: { id: 'MLUCAT', title: 'Catálogo', status: 'active', catalog_listing: true, pictures: [] },
      MLU9: { id: 'MLU9', title: 'Manillar Rojo', status: 'active', attributes: [], pictures: [{ id: 'R1', secure_url: 'https://m.test/rojo1.jpg' }] },
    },
  };
});

async function prepararYGenerar(tipos = ['portada', 'medidas', 'compatible', 'beneficios', 'instalacion']) {
  const prep = await llamar('POST', 'preparar', { skus: ['NEG', 'ROJ'] });
  assert.strictEqual(prep.status, 200);
  const gen = await llamar('POST', 'generar', { variantes: prep.cuerpo.variantes, tipos, textos: prep.cuerpo.textos });
  assert.strictEqual(gen.status, 200, JSON.stringify(gen.cuerpo));
  return { prep: prep.cuerpo, lote: gen.cuerpo.lote };
}

test('preparar: fotos de referencia y color de cada variante, y los textos que propone la IA', async () => {
  const r = await llamar('POST', 'preparar', { skus: ['NEG', 'ROJ'] });
  assert.strictEqual(r.status, 200);
  const [neg, roj] = r.cuerpo.variantes;
  assert.deepStrictEqual(neg.referencias, ['https://m.test/neg1.jpg', 'https://m.test/neg2.jpg']);
  assert.strictEqual(neg.color, 'Negro', 'del atributo de MELI');
  assert.strictEqual(roj.color, 'Rojo', 'sin atributo, del nombre del CRM');
  assert.deepStrictEqual(r.cuerpo.textos.medidas.datos, ['80 cm de largo', 'Ø 22 mm']);
  assert.strictEqual(r.cuerpo.avisoTextos, null);
  assert.strictEqual(hf.envios.length, 0, 'preparar no gasta nada');
});

test('generar crea el pedido sin mandar nada todavía; avanzar respeta el límite de 4 simultáneas', async () => {
  const { lote } = await prepararYGenerar();
  assert.strictEqual(tablas.fotos_ia.length, 9);
  assert.strictEqual(hf.envios.length, 0);

  const r = await llamar('POST', 'avanzar', { lote });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(hf.envios.length, 4);
  assert.strictEqual(porEstado('generando').length, 4);
  assert.strictEqual(porEstado('pendiente').length, 5);
  // Al modelo de Higgsfield, con la foto de MELI de esa variante.
  assert.strictEqual(hf.envios[0].ruta, '/marketing-studio/image/sunburst');
  assert.deepStrictEqual(hf.envios[0].cuerpo.image_urls, ['https://m.test/neg1.jpg', 'https://m.test/neg2.jpg']);
  assert.strictEqual(hf.envios[0].cuerpo.aspect_ratio, '1:1');

  // Una segunda vuelta sin que nada termine no manda más.
  await llamar('POST', 'avanzar', { lote });
  assert.strictEqual(hf.envios.length, 4);
});

test('lo terminado se baja, lleva el logo (menos la portada) y queda en Storage; entran las siguientes', async () => {
  const { lote } = await prepararYGenerar();
  await llamar('POST', 'avanzar', { lote });
  const [a, b] = porEstado('generando');
  hf.estados[a.hf_request_id] = 'completed';
  hf.estados[b.hf_request_id] = 'nsfw';

  const r = await llamar('POST', 'avanzar', { lote });
  assert.strictEqual(fila(a.id).estado, 'lista');
  assert.match(fila(a.id).url_final, /^https:\/\/sb\.test\/storage\/v1\/object\/public\/fotos-ia\/.+\.jpg$/);
  const guardada = subidos[Object.keys(subidos)[0]];
  assert.strictEqual((await sharp(guardada).metadata()).format, 'jpeg');
  assert.strictEqual(fila(b.id).estado, 'error');
  assert.match(fila(b.id).error, /moderación/);
  // Liberaron dos lugares: entraron dos más.
  assert.strictEqual(hf.envios.length, 6);
  assert.strictEqual(porEstado('generando').length, 4);
  assert.strictEqual(r.cuerpo.fotos.length, 9, 'devuelve el lote entero');
});

test('el logo sólo va en las infografías: la portada sale limpia', async () => {
  imagen = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const { lote } = await prepararYGenerar(['portada', 'medidas']);
  await llamar('POST', 'avanzar', { lote });
  for (const f of porEstado('generando')) hf.estados[f.hf_request_id] = 'completed';
  await llamar('POST', 'avanzar', { lote });

  const esquina = async tipo => {
    const f = tablas.fotos_ia.find(x => x.tipo === tipo && x.sku === 'NEG');
    const ruta = f.url_final.split('/fotos-ia/')[1];
    const { channels } = await sharp(subidos[ruta]).extract({ left: 400, top: 20, width: 100, height: 40 }).greyscale().stats();
    return channels[0].min;
  };
  assert.ok(await esquina('portada') > 240, 'portada: la esquina sigue blanca');
  assert.ok(await esquina('medidas') < 100, 'medidas: el logo con letras negras');
});

test('Higgsfield lleno (429): la foto vuelve a la cola, sin error, y no se insiste en esa vuelta', async () => {
  const { lote } = await prepararYGenerar(['portada']);
  hf.respuestasEnvio = [429];
  await llamar('POST', 'avanzar', { lote });
  assert.strictEqual(hf.envios.length, 1);
  assert.strictEqual(porEstado('pendiente').length, 2);
  assert.strictEqual(porEstado('error').length, 0);

  await llamar('POST', 'avanzar', { lote });
  assert.strictEqual(porEstado('generando').length, 2, 'en la vuelta siguiente entran');
});

test('sin respuesta de Higgsfield: queda con error y NO se reenvía sola (pudo cobrarse)', async () => {
  const { lote } = await prepararYGenerar(['portada']);
  hf.respuestasEnvio = ['red'];
  await llamar('POST', 'avanzar', { lote });
  const [mal] = porEstado('error');
  assert.match(mal.error, /no se sabe si Higgsfield la tomó/i);
  await llamar('POST', 'avanzar', { lote });
  assert.strictEqual(hf.envios.filter(e => e.cuerpo.prompt === mal.prompt && e.cuerpo.image_urls[0] === mal.referencias[0]).length, 1);
});

test('sin saldo (403): no se sigue mandando el resto', async () => {
  const { lote } = await prepararYGenerar(['portada', 'medidas']);
  hf.respuestasEnvio = [403];
  await llamar('POST', 'avanzar', { lote });
  assert.strictEqual(hf.envios.length, 1);
  assert.strictEqual(porEstado('error').length, 1);
  assert.match(porEstado('error')[0].error, /saldo/);
  assert.strictEqual(porEstado('pendiente').length, 3);
});

test('publicar: portada primero, en la original por URL y en los ángulos reusando las fotos; el catálogo se saltea', async () => {
  const { lote } = await prepararYGenerar(['portada', 'medidas', 'instalacion']);
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    await llamar('POST', 'avanzar', { lote });
    for (const f of porEstado('generando')) hf.estados[f.hf_request_id] = 'completed';
  }
  assert.strictEqual(porEstado('lista').length, 5, '2 colores × 2 + instalación compartida');

  const r = await llamar('POST', 'publicar', { lote, sku: 'NEG', conservar: false });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.cuerpo.publicadas, 2);
  assert.match(r.cuerpo.resultados.find(x => x.meli_id === 'MLUCAT').error, /catálogo/);

  const [original, angulo] = meli.puts;
  assert.strictEqual(original.id, 'MLU1');
  const urls = original.cuerpo.pictures.map(p => p.source);
  assert.strictEqual(urls.length, 3);
  assert.match(urls[0], /NEG-portada/);
  assert.match(urls[1], /NEG-medidas/);
  assert.match(urls[2], /instalacion/, 'la compartida va también');
  assert.ok(!urls.some(u => /ROJ-/.test(u)), 'nada de la otra variante');
  // El ángulo recibe las MISMAS fotos (ids que MELI les dio en la original).
  assert.strictEqual(angulo.id, 'MLU2');
  assert.deepStrictEqual(angulo.cuerpo.pictures, [{ id: 'PIC-MLU1-0' }, { id: 'PIC-MLU1-1' }, { id: 'PIC-MLU1-2' }]);

  const publicadas = porEstado('publicada');
  assert.strictEqual(publicadas.length, 3);
  assert.ok(publicadas.every(f => f.sku === 'NEG' || f.compartida));
});

test('publicar conservando: las fotos actuales quedan después de las nuevas', async () => {
  const { lote } = await prepararYGenerar(['portada']);
  await llamar('POST', 'avanzar', { lote });
  for (const f of porEstado('generando')) hf.estados[f.hf_request_id] = 'completed';
  await llamar('POST', 'avanzar', { lote });

  await llamar('POST', 'publicar', { lote, sku: 'NEG', conservar: true });
  assert.deepStrictEqual(meli.puts[0].cuerpo.pictures.slice(1), [{ id: 'VIEJA1' }, { id: 'VIEJA2' }]);
});

test('regenerar pide una nueva igual y descarta la vieja; no se puede mientras se genera', async () => {
  const { lote } = await prepararYGenerar(['portada']);
  await llamar('POST', 'avanzar', { lote });
  const [f] = porEstado('generando');
  assert.strictEqual((await llamar('POST', 'regenerar', { id: f.id })).status, 409);

  hf.estados[f.hf_request_id] = 'completed';
  await llamar('POST', 'avanzar', { lote });
  const r = await llamar('POST', 'regenerar', { id: f.id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(fila(f.id).estado, 'descartada');
  assert.strictEqual(r.cuerpo.estado, 'pendiente');
  assert.strictEqual(r.cuerpo.prompt, f.prompt);
});

test('sin clave de Higgsfield no se crea el pedido', async () => {
  const antes = process.env.HIGGSFIELD_API_KEY;
  delete process.env.HIGGSFIELD_API_KEY;
  try {
    const r = await llamar('POST', 'generar', { variantes: [], tipos: ['portada'], textos: {} });
    assert.strictEqual(r.status, 400);
    assert.match(r.cuerpo.error, /HIGGSFIELD_API_KEY/);
    const g = await llamar('GET', null);
    assert.strictEqual(g.cuerpo.configurado.higgsfield, false);
  } finally {
    process.env.HIGGSFIELD_API_KEY = antes;
  }
});

test('la lista de pedidos resume cada lote', async () => {
  const { lote } = await prepararYGenerar(['portada']);
  await llamar('POST', 'avanzar', { lote });
  const r = await llamar('GET', null);
  assert.strictEqual(r.cuerpo.configurado.higgsfield, true);
  const [l] = r.cuerpo.lotes;
  assert.strictEqual(l.lote, lote);
  assert.strictEqual(l.total, 2);
  assert.strictEqual(l.activas, 2);
  assert.deepStrictEqual(l.skus.sort(), ['NEG', 'ROJ']);
});

const dataUrl = async (ancho, alto, formato = 'png') => {
  const buf = await sharp({ create: { width: ancho, height: alto, channels: 3, background: '#336699' } })[formato]().toBuffer();
  return `data:image/${formato};base64,${buf.toString('base64')}`;
};

test('subir: la foto queda lista para publicar, pasada a JPEG y con su orden; las del envío comparten lote', async () => {
  const r1 = await llamar('POST', 'subir', { sku: 'NEG', orden: 1, nombre: '2_medidas.png', datos: await dataUrl(800, 800) });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.cuerpo));
  const { lote } = r1.cuerpo;
  const r0 = await llamar('POST', 'subir', { lote, sku: 'NEG', orden: 0, nombre: '1_portada.webp', datos: await dataUrl(3000, 3000, 'webp') });
  assert.strictEqual(r0.status, 200);
  assert.strictEqual(r0.cuerpo.lote, lote);

  const [a, b] = tablas.fotos_ia;
  assert.deepStrictEqual([a.tipo, a.estado, a.orden, a.prompt], ['subida', 'lista', 1, '2_medidas.png']);
  assert.strictEqual(b.orden, 0);
  const guardada = subidos[b.url_final.split('/fotos-ia/')[1]];
  const meta = await sharp(guardada).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.strictEqual(meta.width, 2048, 'se achica a 2048 como máximo');
  assert.strictEqual(hf.envios.length, 0, 'no pasa por Higgsfield');

  // Publicar respeta el orden del vendedor, no el de llegada.
  await llamar('POST', 'publicar', { lote, sku: 'NEG', conservar: false });
  const fuentes = meli.puts[0].cuerpo.pictures.map(p => p.source);
  assert.deepStrictEqual(fuentes, [b.url_final, a.url_final]);
});

test('subir rechaza fotos chicas, SKU que no existe y archivos que no son imagen', async () => {
  const chica = await llamar('POST', 'subir', { sku: 'NEG', orden: 0, datos: await dataUrl(300, 300) });
  assert.strictEqual(chica.status, 400);
  assert.match(chica.cuerpo.error, /500 px/);
  const sinSku = await llamar('POST', 'subir', { sku: 'NADA', orden: 0, datos: await dataUrl(800, 800) });
  assert.strictEqual(sinSku.status, 404);
  const basura = await llamar('POST', 'subir', { sku: 'NEG', orden: 0, datos: Buffer.from('hola').toString('base64') });
  assert.strictEqual(basura.status, 400);
  assert.match(basura.cuerpo.error, /No se pudo leer la imagen/);
  const sinOrden = await llamar('POST', 'subir', { sku: 'NEG', datos: await dataUrl(800, 800) });
  assert.strictEqual(sinOrden.status, 400);
  assert.strictEqual(tablas.fotos_ia.length, 0);
});

test('una foto subida no se puede "regenerar"', async () => {
  const r = await llamar('POST', 'subir', { sku: 'NEG', orden: 0, datos: await dataUrl(800, 800) });
  const g = await llamar('POST', 'regenerar', { id: r.cuerpo.id });
  assert.strictEqual(g.status, 400);
  assert.match(g.cuerpo.error, /subida a mano/);
});
