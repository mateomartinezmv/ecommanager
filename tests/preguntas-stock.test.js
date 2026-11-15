// Qué dice la respuesta sugerida de una pregunta de MELI sobre el stock, directo sobre
// api/_stockRespuesta.js y construirPrompt de api/_meliPreguntas.js (sin red ni IA).
//
// Lo que se protege: antes la regla fija del prompt era "hay stock" y la IA lo decía también
// de productos agotados. Ahora la disponibilidad sale del CRM (stock_dep, en packs si se vende
// de a par), con "vuelve pronto" si viene en una importación cercana, y la IA nunca afirma
// stock que no hay ni da cantidades o fechas exactas.

const { test } = require('node:test');
const assert = require('node:assert');

const { stockParaRespuesta, lineaStock, reglaStock, partirNombre } = require('../api/_stockRespuesta');
const { construirPrompt } = require('../api/_meliPreguntas');

function fakeSupabase(tablas) {
  class Q {
    constructor(t) { this.t = t; this.filtros = []; }
    select() { return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    neq(c, v) { this.filtros.push(r => String(r[c]) !== String(v)); return this; }
    contains(c, vals) { this.filtros.push(r => Array.isArray(r[c]) && vals.every(v => r[c].includes(v))); return this; }
    limit(n) { this.tope = n; return this; }
    then(ok, mal) {
      const filas = (tablas[this.t] || []).filter(r => this.filtros.every(f => f(r)));
      return Promise.resolve({ data: this.tope ? filas.slice(0, this.tope) : filas, error: null }).then(ok, mal);
    }
  }
  return { from: t => new Q(t) };
}

const HOY = new Date('2026-11-13T15:00:00Z');
const prod = (extra) => ({ sku: 'S1', nombre: 'Manillar', stock_dep: 0, unidades_por_venta: 1, discontinuado: false, meli_ids: ['MLU1'], ...extra });
const imp = (llegada, estado = 'ordered', sku = 'S1') => ({ llegada, estado, items: [{ sku, nombre: 'x', cantidad: 10 }] });

test('con stock: disponibles en packs completos', async () => {
  const s = fakeSupabase({ productos: [prod({ stock_dep: 3, unidades_por_venta: 2 })] });
  const r = await stockParaRespuesta(s, 'MLU1', HOY);
  assert.deepStrictEqual([r.estado, r.disponibles], ['con_stock', 1]);
});

test('un solo item de un par no alcanza: es sin stock', async () => {
  const s = fakeSupabase({ productos: [prod({ stock_dep: 1, unidades_por_venta: 2 })], importaciones: [] });
  assert.strictEqual((await stockParaRespuesta(s, 'MLU1', HOY)).estado, 'sin_stock');
});

test('sin stock pero con importación en los próximos 30 días: vuelve pronto', async () => {
  const s = fakeSupabase({ productos: [prod()], importaciones: [imp('2027-01-20'), imp('2026-12-05')] });
  const r = await stockParaRespuesta(s, 'MLU1', HOY);
  assert.deepStrictEqual([r.estado, r.llegada], ['vuelve_pronto', '2026-12-05']);
});

test('una importación atrasada que todavía no se recibió también es vuelve pronto', async () => {
  const s = fakeSupabase({ productos: [prod()], importaciones: [imp('2026-11-01')] });
  assert.strictEqual((await stockParaRespuesta(s, 'MLU1', HOY)).estado, 'vuelve_pronto');
});

test('importación lejana, recibida, cancelada o de otro SKU: sin stock', async () => {
  const s = fakeSupabase({
    productos: [prod()],
    importaciones: [imp('2027-01-20'), imp('2026-11-20', 'recibido'), imp('2026-11-20', 'cancelada'), imp('2026-11-20', 'ordered', 'OTRO')],
  });
  assert.strictEqual((await stockParaRespuesta(s, 'MLU1', HOY)).estado, 'sin_stock');
});

test('descatalogado y publicación sin vincular', async () => {
  const s = fakeSupabase({ productos: [prod({ stock_dep: 5, discontinuado: true })] });
  assert.strictEqual((await stockParaRespuesta(s, 'MLU1', HOY)).estado, 'descatalogado');
  assert.strictEqual((await stockParaRespuesta(s, 'MLU999', HOY)).estado, 'sin_vincular');
});

test('encuentra el producto también por una publicación secundaria o por meli_id viejo', async () => {
  const s = fakeSupabase({ productos: [prod({ stock_dep: 2, meli_ids: ['MLU1', 'MLU2'] }), prod({ sku: 'S9', stock_dep: 4, meli_ids: [], meli_id: 'MLU9' })] });
  assert.strictEqual((await stockParaRespuesta(s, 'MLU2', HOY)).sku, 'S1');
  assert.strictEqual((await stockParaRespuesta(s, 'MLU9', HOY)).sku, 'S9');
});

test('el prompt sólo dice que hay stock cuando el CRM lo confirma', () => {
  const q = { text: '¿Tenés stock?' };
  const con = construirPrompt(q, 'Manillar', { estado: 'con_stock', disponibles: 4 });
  assert.match(con, /Hay stock\. No digas cuántas unidades quedan/);
  assert.doesNotMatch(con, /\b4\b/, 'no le pasa la cantidad');

  for (const stock of [{ estado: 'sin_stock' }, { estado: 'descatalogado' }, { estado: 'vuelve_pronto', llegada: '2026-12-05' }]) {
    const p = construirPrompt(q, 'Manillar', stock);
    assert.match(p, /NO hay stock|ya no se vende/, stock.estado);
    assert.doesNotMatch(p, /Hay stock\. No digas/, stock.estado);
    assert.match(p, /aclarale en una frase corta que por ahora no hay stock/, stock.estado);
  }
  const pronto = construirPrompt(q, 'Manillar', { estado: 'vuelve_pronto', llegada: '2026-12-05' });
  assert.match(pronto, /vuelve pronto, sin dar una fecha exacta/);
  assert.match(pronto, /diciembre/);
  assert.doesNotMatch(pronto, /2026-12-05/, 'nunca la fecha exacta');

  for (const stock of [undefined, { estado: 'sin_vincular' }]) {
    const p = construirPrompt(q, 'Manillar', stock);
    assert.match(p, /no lo confirmes ni lo niegues/);
    assert.doesNotMatch(p, /Hay stock\. No digas/);
  }
});

test('la línea para Telegram dice qué dato usó', () => {
  assert.match(lineaStock({ estado: 'con_stock', disponibles: 1 }), /1 disponible$/);
  assert.match(lineaStock({ estado: 'vuelve_pronto', llegada: '2026-12-05' }), /llegada estimada 2026-12-05/);
  assert.match(lineaStock({ estado: 'sin_vincular' }), /no está vinculada/);
  assert.strictEqual(lineaStock(null), null);
  assert.ok(reglaStock({ estado: 'con_stock' }));
});

test('listarRecientes: pagina hasta la fecha de corte, con la respuesta de cada pregunta', async () => {
  const { listarRecientes } = require('../api/_meliPreguntas');
  const pedidas = [];
  const pagina = (offset) => Array.from({ length: 50 }, (_, i) => {
    const n = offset + i;
    const dia = String(30 - Math.floor(n / 4)).padStart(2, '0');
    return { id: n, item_id: 'MLU1', date_created: `2026-11-${dia}T10:00:00.000-03:00`, status: 'ANSWERED',
      text: `pregunta ${n}`, answer: n % 2 ? { text: `respuesta ${n}` } : null };
  });
  const original = global.fetch;
  global.fetch = async (url) => {
    pedidas.push(String(url));
    const offset = Number(new URL(url).searchParams.get('offset'));
    return { ok: true, status: 200, json: async () => ({ questions: pagina(offset) }) };
  };
  try {
    const r = await listarRecientes('tok', 123, { desde: '2026-11-10', max: 1000 });
    assert.ok(r.every(q => q.fecha >= '2026-11-10'), 'nada anterior al corte');
    assert.strictEqual(r.length, 84, 'del 30 al 10 de noviembre, 4 por día');
    assert.deepStrictEqual(r[1], { id: 1, item_id: 'MLU1', fecha: '2026-11-30', estado: 'ANSWERED', texto: 'pregunta 1', respuesta: 'respuesta 1' });
    assert.strictEqual(pedidas.length, 2, 'deja de paginar al pasar la fecha');
    assert.match(pedidas[0], /seller_id=123/);

    const tope = await listarRecientes('tok', 123, { max: 30 });
    assert.strictEqual(tope.length, 30);
  } finally {
    global.fetch = original;
  }
});

// ── Variantes (el mismo producto en otros colores) ─────────────────────────

const guardamanos = (color, stock, extra = {}) => ({
  sku: `GM-${color}`, nombre: `Guardamanos Protector Puños Moto Enduro Cross ABS - ${color}`, grupo: 'Protección',
  stock_dep: stock, unidades_por_venta: 1, discontinuado: false, meli_ids: [`MLU-${color}`], ...extra,
});

test('partirNombre: la última palabra es la variante, con o sin guion', () => {
  assert.deepStrictEqual(partirNombre('Guardamanos Protector Puños Moto Enduro Cross ABS - Rojo'),
    { base: 'guardamanos protector punos moto enduro cross abs', variante: 'Rojo' });
  assert.deepStrictEqual(partirNombre('Puños Domino Para Moto Manubrio Goma Antideslizante Azul'),
    { base: 'punos domino para moto manubrio goma antideslizante', variante: 'Azul' });
});

test('variantes: el rojo sabe que el azul tiene stock y el negro no', async () => {
  const s = fakeSupabase({
    productos: [
      guardamanos('Rojo', 3), guardamanos('Azul', 6), guardamanos('Negro', 0),
      // Otro guardamanos, otro producto: no es variante.
      { sku: 'HP-HS010', nombre: 'Guardamanos Moto Con Señalero LED Integrado Negro', grupo: 'Protección', stock_dep: 1, unidades_por_venta: 1, discontinuado: false, meli_ids: ['MLU9'] },
      // Mismo nombre base en otro grupo: tampoco.
      { sku: 'OTRO', nombre: 'Guardamanos Protector Puños Moto Enduro Cross ABS - Verde', grupo: 'Otros', stock_dep: 4, unidades_por_venta: 1, discontinuado: false, meli_ids: [] },
    ],
    importaciones: [],
  });
  const r = await stockParaRespuesta(s, 'MLU-Rojo', HOY);
  assert.strictEqual(r.estado, 'con_stock');
  assert.deepStrictEqual(r.variantes.map(v => [v.variante, v.estado, v.actual]),
    [['Rojo', 'con_stock', true], ['Azul', 'con_stock', false], ['Negro', 'sin_stock', false]]);

  const prompt = construirPrompt({ text: 'hola. Tenés Blancos o Negros?' }, 'Guardamanos Rojo', r);
  assert.match(prompt, /Rojo \(la de esta publicación\): hay stock; Azul: hay stock; Negro: sin stock por ahora/);
  assert.match(prompt, /esa no la traemos/);
  assert.match(prompt, /Nunca le digas que consulte de nuevo/);
  assert.doesNotMatch(prompt, /Verde/);

  assert.match(lineaStock(r), /3 disponibles\n🎨 <b>Otras variantes:<\/b> Azul 6 · Negro sin stock/);
});

test('variantes: la que llega en una importación dice que llega pronto; la descatalogada, que no se trae', async () => {
  const s = fakeSupabase({
    productos: [guardamanos('Rojo', 3), guardamanos('Negro', 0), guardamanos('Azul', 0, { discontinuado: true })],
    importaciones: [imp('2026-12-05', 'ordered', 'GM-Negro')],
  });
  const r = await stockParaRespuesta(s, 'MLU-Rojo', HOY);
  const prompt = construirPrompt({ text: '¿En negro?' }, 'Guardamanos Rojo', r);
  assert.match(prompt, /Negro: sin stock, pero llega pronto/);
  assert.match(prompt, /Azul: ya no la traemos/);
  assert.match(lineaStock(r), /Negro sin stock \(llega ~2026-12-05\)/);
});

test('sin variantes: a otro color se contesta que solo está la de la publicación', async () => {
  const s = fakeSupabase({ productos: [prod({ stock_dep: 2 })], importaciones: [] });
  const r = await stockParaRespuesta(s, 'MLU1', HOY);
  assert.strictEqual(r.variantes, undefined);
  assert.match(reglaStock(r), /solo tenemos la de la publicación/);
  assert.doesNotMatch(lineaStock(r), /Otras variantes/);
});
