// Auditoría quincenal de publicaciones de MELI, directo sobre api/_auditoriaPubs.js con los
// endpoints del CRM, MELI y Supabase simulados (sin navegador ni red).
//
// Lo que se protege:
//  · Qué publicaciones se miran en detalle: sólo productos con stock y no descatalogados; las
//    que la gente ve y no compra (con visitas suficientes para que el % no sea ruido), las
//    que casi nadie ve, y unas pocas que andan bien como referencia, sin repetir productos.
//  · Cada parte guarda lo que devuelve la pantalla del CRM; fotos sólo lo que está distinto.
//  · `publicaciones` usa la conversión guardada ese día y falla claro si todavía no está.
//  · Las preguntas quedan agrupadas por producto (por cualquiera de sus publicaciones).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

function simular(relativo, exportaciones) {
  const p = path.join(__dirname, '..', relativo);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportaciones };
}

function fakeSupabase(tablas) {
  class Q {
    constructor(t) { this.t = t; this.filtros = []; this.op = 'select'; }
    select() { return this; }
    upsert(f) { this.op = 'upsert'; this.payload = f; return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    maybeSingle() { this.unica = true; return this; }
    then(ok, mal) { return Promise.resolve().then(() => this.correr()).then(ok, mal); }
    correr() {
      const filas = (tablas[this.t] ||= []);
      if (this.op === 'upsert') {
        const n = this.payload;
        const i = filas.findIndex(r => r.fecha === n.fecha && r.parte === n.parte);
        if (i >= 0) filas[i] = { ...filas[i], ...n }; else filas.push({ ...n });
        return { error: null };
      }
      const cumplen = filas.filter(r => this.filtros.every(f => f(r)));
      if (this.unica) return { data: cumplen[0] ? { ...cumplen[0] } : null, error: null };
      return { data: cumplen.map(r => ({ ...r })), error: null };
    }
  }
  return { _tablas: tablas, from: t => new Q(t) };
}

// ── Endpoints del CRM y MELI simulados ─────────────────────────────────────
const respuestas = {};
const llamadosMeli = [];
const handler = nombre => async (req, res) => res.status(200).json(respuestas[nombre] ?? { ok: true });
const conversion = handler('conversion');
conversion.traerVisitas = async (token, ids) => Object.fromEntries(ids.map((id, i) => [id, 100 + i]));
simular('api/meli/conversion.js', conversion);
simular('api/meli/angulos.js', handler('angulos'));
simular('api/meli/fotos.js', handler('fotos'));
simular('api/_meliToken.js', { getMeliToken: async () => 'tok' });
simular('api/_meliPublicaciones.js', {
  meliFetch: async (token, ruta) => {
    llamadosMeli.push(ruta);
    if (ruta.startsWith('/items?ids=')) {
      const ids = ruta.slice('/items?ids='.length).split('&')[0].split(',');
      return { ok: true, data: ids.map(id => ({ code: 200, body: {
        id, title: `Título ${id}`, price: 1190, status: 'active', sold_quantity: 3,
        shipping: { free_shipping: true, logistic_type: 'self_service' },
        pictures: [{}, {}, {}], attributes: [{ id: 'BRAND', name: 'Marca', value_name: 'Genérica' }, { id: 'X', name: 'Vacío', value_name: null }],
      } })) };
    }
    if (ruta.endsWith('/description')) return { ok: true, data: { plain_text: 'Manillar de aluminio. ' + 'x'.repeat(3000) } };
    return { ok: false, data: {} };
  },
});
const preguntasMeli = [];
simular('api/_meliPreguntas.js', {
  getSellerId: async () => 123,
  listarRecientes: async (token, seller, { desde }) => { preguntasMeli.desde = desde; return preguntasMeli; },
  titulosDeItems: async (token, ids) => Object.fromEntries(ids.map(id => [id, `Suelta ${id}`])),
});

const { elegirCandidatas, resumirItem, agruparPreguntas, correrParte } = require('../api/_auditoriaPubs');

beforeEach(() => {
  for (const k of Object.keys(respuestas)) delete respuestas[k];
  llamadosMeli.length = 0;
  preguntasMeli.length = 0;
});

const prod = (sku, extra = {}) => ({ sku, nombre: `Prod ${sku}`, stock_dep: 5, unidades_por_venta: 1, discontinuado: false, meli_ids: [`MLU${sku}`], precio: 1000, ...extra });
const conv = (sku, visitas, vendidas, extra = {}) => ({
  sku, nombre: `Prod ${sku}`, visitas, vendidas,
  conversion: visitas ? vendidas / visitas : null, pocas_visitas: visitas != null && visitas < 30, fotos_nuevas: false, ...extra,
});

// ── Candidatas ─────────────────────────────────────────────────────────────

test('candidatas: no convence, no aparece y referencia, sólo con stock', () => {
  const productos = [prod('A'), prod('B'), prod('C'), prod('D', { stock_dep: 0 }), prod('E'), prod('F', { discontinuado: true }), prod('G', { stock_dep: 1, unidades_por_venta: 2 }), prod('H', { stock_dep: 9 })];
  const conversion = [
    conv('A', 500, 2),     // 0,4%: la peor con visitas
    conv('B', 200, 4),     // 2%
    conv('D', 400, 0),     // sin stock: afuera
    conv('F', 300, 0),     // descatalogado: afuera
    conv('G', 300, 0),     // 1 unidad de un par: sin stock
    conv('C', 10, 0),      // pocas visitas
    conv('H', 0, 0),       // ninguna visita
    conv('E', 100, 10),    // 10%: la mejor
  ];
  const r = elegirCandidatas(conversion, productos, { noConvence: 2, noAparece: 2, referencia: 1 });
  assert.deepStrictEqual(r.map(c => [c.sku, c.motivo]), [
    ['A', 'no_convence'], ['B', 'no_convence'],
    ['H', 'no_aparece'], ['C', 'no_aparece'],
    ['E', 'referencia'],
  ]);
});

test('candidatas: un producto no aparece dos veces', () => {
  const productos = [prod('A'), prod('B')];
  const r = elegirCandidatas([conv('A', 100, 1), conv('B', 100, 5)], productos, { noConvence: 5, referencia: 5 });
  assert.deepStrictEqual(r.map(c => c.sku), ['A', 'B']);
});

// ── Resúmenes ──────────────────────────────────────────────────────────────

test('resumirItem: lo que sirve para mejorar la publicación', () => {
  const r = resumirItem({
    id: 'MLU1', title: 'Manillar 22mm', price: 1190, status: 'active', sold_quantity: 7,
    listing_type_id: 'gold_special', catalog_listing: false, shipping: { free_shipping: false },
    pictures: [{}, {}], attributes: [{ name: 'Color', value_name: 'Rojo' }, { name: 'Material', value_name: null }], health: 0.8,
  }, 340);
  assert.deepStrictEqual(r, {
    meli_id: 'MLU1', titulo: 'Manillar 22mm', largo_titulo: 13, precio: 1190, estado: 'active', vendidos: 7,
    tipo: 'gold_special', catalogo: false, condicion: null, envio_gratis: false, logistica: null,
    fotos: 2, atributos_cargados: 1, atributos: [{ nombre: 'Color', valor: 'Rojo' }], salud: 0.8, visitas_30d: 340,
  });
});

test('preguntas: agrupadas por producto, por cualquiera de sus publicaciones', () => {
  const productos = [prod('A', { meli_ids: ['MLU1', 'MLU2'] }), prod('B', { meli_ids: ['MLU3'] })];
  const r = agruparPreguntas([
    { item_id: 'MLU2', texto: '¿Sirve para Wave?', respuesta: 'Sí', fecha: '2026-11-01', estado: 'ANSWERED' },
    { item_id: 'MLU1', texto: '¿Medida?', respuesta: null, fecha: '2026-11-02', estado: 'UNANSWERED' },
    { item_id: 'MLU3', texto: '¿Color?', respuesta: 'Negro', fecha: '2026-11-03', estado: 'ANSWERED' },
    { item_id: 'MLU9', texto: '¿Envían?', respuesta: 'Sí', fecha: '2026-11-03', estado: 'ANSWERED' },
  ], productos, { MLU9: 'Publicación vieja' });
  assert.deepStrictEqual(r.por_producto.map(g => [g.sku, g.preguntas.length]), [['A', 2], ['B', 1]]);
  assert.deepStrictEqual(r.sin_vincular, [{ item_id: 'MLU9', titulo: 'Publicación vieja',
    preguntas: [{ fecha: '2026-11-03', pregunta: '¿Envían?', respuesta: 'Sí', estado: 'ANSWERED' }] }]);
});

// ── Partes ─────────────────────────────────────────────────────────────────

const AHORA = new Date('2026-12-01T15:30:00Z');   // 1/12, 12:30 en Montevideo

test('conversion y angulos se guardan con la fecha del día', async () => {
  const s = fakeSupabase({});
  respuestas.conversion = { dias: 30, productos: [conv('A', 100, 1)] };
  respuestas.angulos = { ok: true, objetivo: 3, productos: [{ sku: 'A', publicaciones: [{ meli_id: 'M', titulo: 'T', permalink: 'x' }] }], historial: [1, 2] };
  await correrParte(s, 'conversion', AHORA);
  await correrParte(s, 'angulos', AHORA);
  const [c, a] = s._tablas.pubs_auditoria_partes;
  assert.deepStrictEqual([c.fecha, c.parte, c.ok], ['2026-12-01', 'conversion', true]);
  assert.deepStrictEqual(a.datos, { objetivo: 3, productos: [{ sku: 'A', publicaciones: [{ meli_id: 'M', titulo: 'T' }] }], sin_tabla: undefined });
});

test('fotos: sólo los productos con ángulos distintos a la original, sin las fotos', async () => {
  const s = fakeSupabase({});
  respuestas.fotos = { ok: true, resumen: { distintas: 1 }, productos: [
    { sku: 'A', distintas: 1, publicaciones: [{ meli_id: 'M', fotos: ['f1', 'f2'], distintas: true }] },
    { sku: 'B', distintas: 0, publicaciones: [] },
  ] };
  await correrParte(s, 'fotos', AHORA);
  assert.deepStrictEqual(s._tablas.pubs_auditoria_partes[0].datos.productos,
    [{ sku: 'A', distintas: 1, publicaciones: [{ meli_id: 'M', distintas: true }] }]);
});

test('un endpoint que falla queda anotado', async () => {
  const s = fakeSupabase({});
  respuestas.angulos = { ok: false, error: 'MELI no está conectado. Autorizá la app primero.' };
  const r = await correrParte(s, 'angulos', AHORA);
  assert.deepStrictEqual([r.ok, r.error], [false, 'MELI no está conectado. Autorizá la app primero.']);
});

test('publicaciones: sin la conversión del día, error claro y sin llamar a MELI', async () => {
  const s = fakeSupabase({ productos: [prod('A')] });
  const r = await correrParte(s, 'publicaciones', AHORA);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Falta la parte conversion/);
  assert.strictEqual(llamadosMeli.length, 0);
});

test('publicaciones: detalle de cada candidata con visitas, fotos, atributos y descripción', async () => {
  const s = fakeSupabase({
    productos: [prod('A', { meli_ids: ['MLUA', 'MLUA2'] }), prod('B')],
    pubs_auditoria_partes: [{ fecha: '2026-12-01', parte: 'conversion', ok: true,
      datos: { productos: [conv('A', 400, 1), conv('B', 5, 0)] } }],
  });
  const r = await correrParte(s, 'publicaciones', AHORA);
  assert.strictEqual(r.ok, true);
  const datos = s._tablas.pubs_auditoria_partes.find(f => f.parte === 'publicaciones').datos;
  const [a, b] = datos.candidatas;
  assert.deepStrictEqual([a.sku, a.motivo, a.conversion_pct, a.stock], ['A', 'no_convence', 0.25, 5]);
  assert.deepStrictEqual([b.sku, b.motivo], ['B', 'no_aparece']);
  assert.deepStrictEqual(a.publicaciones.map(p => [p.meli_id, p.fotos, p.atributos_cargados, p.envio_gratis]),
    [['MLUA', 3, 1, true], ['MLUA2', 3, 1, true]]);
  assert.ok(a.publicaciones.every(p => p.visitas_30d >= 100));
  assert.ok(a.descripcion.startsWith('Manillar de aluminio.'));
  assert.strictEqual(a.descripcion.length, 1500, 'la descripción se recorta');
  assert.ok(llamadosMeli.includes('/items/MLUA/description'), 'la descripción es de la principal');
});

test('preguntas: 60 días hacia atrás, agrupadas por producto', async () => {
  const s = fakeSupabase({ productos: [prod('A', { meli_ids: ['MLU1'] })] });
  preguntasMeli.push(
    { item_id: 'MLU1', texto: '¿Sirve para Wave?', respuesta: 'Sí', fecha: '2026-11-20', estado: 'ANSWERED' },
    { item_id: 'MLU7', texto: '¿Envían?', respuesta: null, fecha: '2026-11-21', estado: 'UNANSWERED' },
  );
  await correrParte(s, 'preguntas', AHORA);
  assert.strictEqual(preguntasMeli.desde, '2026-10-02');
  const d = s._tablas.pubs_auditoria_partes[0].datos;
  assert.strictEqual(d.total, 2);
  assert.deepStrictEqual(d.por_producto.map(g => g.sku), ['A']);
  assert.deepStrictEqual(d.sin_vincular.map(g => [g.item_id, g.titulo]), [['MLU7', 'Suelta MLU7']]);
});
