// GestionPost: la tarifa por zona y el retiro de $75 (directo sobre api/_flexZonas.js,
// api/_retiroFlex.js y api/envios.js, sin navegador ni red).
//
// Lo que se protege:
//   · La tarifa de GestionPost (sacada de sus envíos reales y confirmada con lo que cobraron):
//     $169 zonas 5-7, $200 zonas 1-4 y 10, $290 zonas 8, 9 y 11, y El Dorado a $290 aunque
//     sea zona 10. La excepción se mira en el barrio, no en la calle.
//   · Que todo envío Flex nuevo salga por GestionPost.
//   · La jornada de despacho: de corte a corte (16:00 de lunes a viernes, 13:00 los sábados,
//     14:00 los domingos, hora de Montevideo).
//   · El retiro: con menos de 3 envíos de GestionPost en la jornada se cobra en cada uno;
//     con 3 o más, en ninguno. Se recalcula al crear, borrar o cambiar de transportista un
//     envío, y no al tocar el toggle a mano.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { costoFlex, calcularCostoFlexDesdeShipData, TRANSPORTISTA_FLEX } = require('../api/_flexZonas');
const { jornadaDe, recalcularRetiro } = require('../api/_retiroFlex');

// Lo justo de PostgREST que usan estos módulos, sobre tablas en memoria.
function fakeSupabase(tablas) {
  class Q {
    constructor(t) { this.t = t; this.filtros = []; this.op = 'select'; }
    select() { this.devolver = true; return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    gte(c, v) { this.filtros.push(r => new Date(r[c]) >= new Date(v)); return this; }
    lt(c, v) { this.filtros.push(r => new Date(r[c]) < new Date(v)); return this; }
    in(c, vs) { this.filtros.push(r => vs.map(String).includes(String(r[c]))); return this; }
    order() { return this; }
    filas() { return tablas[this.t].filter(r => this.filtros.every(f => f(r))); }
    insert(fila) {
      this.op = 'insert';
      this.fila = { created_at: new Date().toISOString(), colecta: false, ...fila };
      return this;
    }
    update(cambios) { this.op = 'update'; this.cambios = cambios; return this; }
    delete() { this.op = 'delete'; return this; }
    ejecutar() {
      if (this.op === 'insert') { tablas[this.t].push(this.fila); return { data: [{ ...this.fila }], error: null }; }
      if (this.op === 'update') { const fs = this.filas(); fs.forEach(f => Object.assign(f, this.cambios)); return { data: fs.map(f => ({ ...f })), error: null }; }
      if (this.op === 'delete') { const fuera = new Set(this.filas()); tablas[this.t] = tablas[this.t].filter(f => !fuera.has(f)); return { error: null }; }
      return { data: this.filas().map(f => ({ ...f })), error: null };
    }
    single() { const r = this.ejecutar(); return Promise.resolve({ data: r.data?.[0] || null, error: r.error }); }
    maybeSingle() { return this.single(); }
    then(ok, mal) { return Promise.resolve(this.ejecutar()).then(ok, mal); }
  }
  return { _tablas: tablas, from: t => new Q(t) };
}

const uy = (fechaHora) => new Date(`${fechaHora}:00-03:00`).toISOString();
const envio = (id, creado, extra = {}) => ({ id, transportista: 'gestionpost', colecta: false, estado: 'pendiente', created_at: uy(creado), ...extra });
const colectas = (sb) => Object.fromEntries(sb._tablas.envios.map(e => [e.id, !!e.colecta]));

// ── Tarifa ──────────────────────────────────────────────────────────────────

test('tarifa de GestionPost por zona', () => {
  const esperado = { 1: 200, 2: 200, 3: 200, 4: 200, 5: 169, 6: 169, 7: 169, 8: 290, 9: 290, 10: 200, 11: 290 };
  for (const [zona, costo] of Object.entries(esperado)) {
    assert.strictEqual(costoFlex('gestionpost', Number(zona), 'Calle 1234, Barrio'), costo, `zona ${zona}`);
  }
  assert.strictEqual(costoFlex('gestionpost', null, 'x'), null, 'sin zona no hay costo');
});

test('El Dorado sale $290 aunque sea zona 10, pero sólo si es el barrio y no la calle', () => {
  // Como la arma el webhook de MELI: calle, número, barrio, ciudad, departamento.
  assert.strictEqual(costoFlex('gestionpost', 10, 'M3 S8 18 de mayo, SN, El Dorado, El Dorado, Canelones'), 290);
  // El barrio elegido del catálogo en el formulario: un solo tramo.
  assert.strictEqual(costoFlex('gestionpost', 10, 'El Dorado'), 290);
  // "esq el dorado" es una calle del Aeropuerto: zona 10 común.
  assert.strictEqual(costoFlex('gestionpost', 10, 'Aeropuerto calle cardenal esq el dorado, SN, Aeropuerto Internacional De Carrasco, Canelones'), 200);
  assert.strictEqual(costoFlex('gestionpost', 10, 'Giannattasio 3404, Solymar, Canelones'), 200);
});

test('EnviosUy conserva su tarifa y MMOTOS no tiene tabla', () => {
  assert.strictEqual(costoFlex('enviosuy', 6, 'x, Pocitos'), 160);
  assert.strictEqual(costoFlex('enviosuy', 10, 'x, El Dorado'), 200, 'la excepción es sólo de GestionPost');
  assert.strictEqual(costoFlex('enviosuy', 11, 'x'), null);
  assert.strictEqual(costoFlex('mmotos_mateo', 5, 'x'), null);
});

test('un Flex de MELI sale por GestionPost con su costo', () => {
  assert.strictEqual(TRANSPORTISTA_FLEX, 'gestionpost');
  const ship = { receiver_address: { street_name: 'Timoteo Aparicio', street_number: '4169', neighborhood: { name: 'Unión' }, city: { name: 'Montevideo' } } };
  assert.deepStrictEqual(calcularCostoFlexDesdeShipData(ship), { zona: 5, transportista: 'gestionpost', costo: 169 });
});

// ── Jornada ─────────────────────────────────────────────────────────────────

test('jornada de lunes a viernes: corte a las 16:00', () => {
  // Martes 17/11/2026
  assert.strictEqual(jornadaDe(uy('2026-11-17T15:59')).dia, '2026-11-17');
  assert.strictEqual(jornadaDe(uy('2026-11-17T16:00')).dia, '2026-11-18');
  assert.strictEqual(jornadaDe(uy('2026-11-17T00:30')).dia, '2026-11-17', 'la madrugada es del mismo día');
  assert.deepStrictEqual(jornadaDe(uy('2026-11-17T10:00')), { dia: '2026-11-17', desde: uy('2026-11-16T16:00'), hasta: uy('2026-11-17T16:00') });
});

test('jornada del sábado: corte a las 13:00, arranca el viernes a las 16:00', () => {
  assert.deepStrictEqual(jornadaDe(uy('2026-11-13T16:01')), { dia: '2026-11-14', desde: uy('2026-11-13T16:00'), hasta: uy('2026-11-14T13:00') });
  assert.strictEqual(jornadaDe(uy('2026-11-14T12:59')).dia, '2026-11-14');
  assert.strictEqual(jornadaDe(uy('2026-11-14T13:00')).dia, '2026-11-15');
});

test('jornada del domingo: corte a las 14:00; la del lunes arranca el domingo a las 14:00', () => {
  assert.deepStrictEqual(jornadaDe(uy('2026-11-14T13:01')), { dia: '2026-11-15', desde: uy('2026-11-14T13:00'), hasta: uy('2026-11-15T14:00') });
  assert.strictEqual(jornadaDe(uy('2026-11-15T13:59')).dia, '2026-11-15');
  assert.deepStrictEqual(jornadaDe(uy('2026-11-15T14:00')), { dia: '2026-11-16', desde: uy('2026-11-15T14:00'), hasta: uy('2026-11-16T16:00') });
});

// ── Retiro ──────────────────────────────────────────────────────────────────

test('con menos de 3 envíos en la jornada se cobra el retiro en cada uno', async () => {
  const sb = fakeSupabase({ envios: [envio('A', '2026-11-16T17:00'), envio('B', '2026-11-17T09:00')] });
  const r = await recalcularRetiro(sb, uy('2026-11-17T09:00'));
  assert.strictEqual(r.dia, '2026-11-17');
  assert.strictEqual(r.envios, 2);
  assert.deepStrictEqual(colectas(sb), { A: true, B: true });
});

test('con 3 o más se apaga el retiro de toda la jornada', async () => {
  const sb = fakeSupabase({ envios: [
    envio('A', '2026-11-16T17:00', { colecta: true }),
    envio('B', '2026-11-17T09:00', { colecta: true }),
    envio('C', '2026-11-17T15:59'),
  ] });
  const r = await recalcularRetiro(sb, uy('2026-11-17T15:59'));
  assert.strictEqual(r.envios, 3);
  assert.strictEqual(r.retiro, false);
  assert.deepStrictEqual(colectas(sb), { A: false, B: false, C: false });
});

test('sólo cuentan los envíos de GestionPost de esa jornada', async () => {
  const sb = fakeSupabase({ envios: [
    envio('ANTES', '2026-11-16T15:59'),                                  // jornada del lunes
    envio('A', '2026-11-16T16:00'),
    envio('MOTO', '2026-11-17T10:00', { transportista: 'mmotos_mateo' }),
    envio('MELI', '2026-11-17T11:00', { transportista: 'mercado_envios' }),
    envio('B', '2026-11-17T12:00'),
    envio('DESPUES', '2026-11-17T16:00'),                                // jornada del miércoles
  ] });
  await recalcularRetiro(sb, uy('2026-11-17T12:00'));
  assert.deepStrictEqual(colectas(sb), { ANTES: false, A: true, MOTO: false, MELI: false, B: true, DESPUES: false });
});

// ── API de envíos ───────────────────────────────────────────────────────────

const supabasePath = require.resolve(path.join(__dirname, '../api/_supabase'));
let sbActual;
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { getSupabase: () => sbActual } };
const tokenPath = require.resolve(path.join(__dirname, '../api/_meliToken'));
require.cache[tokenPath] = { id: tokenPath, filename: tokenPath, loaded: true, exports: { getMeliToken: async () => 'TOKEN' } };
const enviosApi = require('../api/envios');

async function llamar(method, { query = {}, body } = {}) {
  let status = 200; let json;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { json = j; return this; }, end() { return this; } };
  await enviosApi({ method, query, body }, res);
  return { status, json };
}

test('crear, borrar y cambiar de transportista un envío recalcula el retiro de su jornada', async () => {
  const ahora = new Date().toISOString();
  sbActual = fakeSupabase({ envios: [envio('A', '2026-11-17T09:00', { created_at: ahora })] });

  // Segundo envío de la jornada: los dos con retiro.
  let r = await llamar('POST', { body: { id: 'B', transportista: 'gestionpost', costo: 169, zona: 6 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.colecta, true);
  assert.deepStrictEqual(colectas(sbActual), { A: true, B: true });

  // Tercero: se apaga en los tres.
  r = await llamar('POST', { body: { id: 'C', transportista: 'gestionpost', costo: 200, zona: 10 } });
  assert.strictEqual(r.json.colecta, false);
  assert.deepStrictEqual(colectas(sbActual), { A: false, B: false, C: false });

  // C pasa a MMOTOS: quedan 2 de GestionPost, vuelve el retiro.
  r = await llamar('PUT', { query: { id: 'C' }, body: { transportista: 'mmotos_mateo', colecta: false } });
  assert.deepStrictEqual(colectas(sbActual), { A: true, B: true, C: false });

  // Vuelve a GestionPost: otra vez 3.
  await llamar('PUT', { query: { id: 'C' }, body: { transportista: 'gestionpost' } });
  assert.deepStrictEqual(colectas(sbActual), { A: false, B: false, C: false });

  // Se borra uno: quedan 2.
  await llamar('DELETE', { query: { id: 'B' } });
  assert.deepStrictEqual(colectas(sbActual), { A: true, C: true });
});

test('tocar el toggle a mano o editar sin cambiar de transportista no recalcula', async () => {
  const ahora = new Date().toISOString();
  sbActual = fakeSupabase({ envios: [envio('A', '2026-11-17T09:00', { created_at: ahora, colecta: true })] });
  await llamar('PUT', { query: { id: 'A' }, body: { colecta: false } });
  assert.strictEqual(sbActual._tablas.envios[0].colecta, false);
  // El modal de edición manda todo, incluido el mismo transportista.
  await llamar('PUT', { query: { id: 'A' }, body: { transportista: 'gestionpost', colecta: false, estado: 'en_camino' } });
  assert.strictEqual(sbActual._tablas.envios[0].colecta, false);
});

test('un envío de otro transportista no toca el retiro', async () => {
  const ahora = new Date().toISOString();
  sbActual = fakeSupabase({ envios: [envio('A', '2026-11-17T09:00', { created_at: ahora, colecta: true }), envio('B', '2026-11-17T09:00', { created_at: ahora, colecta: true })] });
  await llamar('POST', { body: { id: 'U', transportista: 'ues', costo: 300 } });
  assert.deepStrictEqual(colectas(sbActual), { A: true, B: true, U: false });
});
