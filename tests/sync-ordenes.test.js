// Red de seguridad de las ventas de MELI, directo sobre api/_syncOrdenes.js con Supabase en
// memoria y el webhook simulado (sin red).
//
// Lo que se protege: que sólo se manden por el webhook las órdenes pagadas que no están en
// ventas; que cada una se intente una sola vez (una publicación sin vincular no avisa por
// Telegram cada 2 horas); y que si el webhook falla, quede anotado y el resto siga.

const { test } = require('node:test');
const assert = require('node:assert');
const { sincronizarOrdenes, TOPIC } = require('../api/_syncOrdenes');

function fakeSupabase(tablas) {
  class Q {
    constructor(t) { this.t = t; this.filtros = []; this.op = 'select'; }
    select() { return this; }
    insert(f) { this.op = 'insert'; this.payload = f; return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    in(c, vals) { this.filtros.push(r => vals.map(String).includes(String(r[c]))); return this; }
    then(ok, mal) {
      return Promise.resolve().then(() => {
        const filas = (tablas[this.t] ||= []);
        if (this.op === 'insert') { filas.push({ ...this.payload }); return { error: null }; }
        return { data: filas.filter(r => this.filtros.every(f => f(r))).map(r => ({ ...r })), error: null };
      }).then(ok, mal);
    }
  }
  return { _tablas: tablas, from: t => new Q(t) };
}

test('sólo procesa las órdenes que faltan, y las registra por el webhook', async () => {
  const s = fakeSupabase({ ventas: [{ id: 'V1', orden_meli: '1' }], meli_notify_log: [] });
  const procesadas = [];
  const r = await sincronizarOrdenes(s, {
    listar: async () => ['1', '2', '3'],
    procesar: async (id) => { procesadas.push(id); s._tablas.ventas.push({ id: `V${id}`, orden_meli: id }); },
  });
  assert.deepStrictEqual(procesadas, ['2', '3']);
  assert.deepStrictEqual([r.revisadas, r.ya_estaban], [3, 1]);
  assert.deepStrictEqual(r.procesadas.map(p => [p.orden, p.registrada]), [['2', true], ['3', true]]);
  assert.deepStrictEqual(s._tablas.meli_notify_log.map(l => [l.topic, l.resource, l.error]),
    [[TOPIC, '2', null], [TOPIC, '3', null]]);
});

test('una orden que no se pudo registrar se intenta una sola vez', async () => {
  const s = fakeSupabase({ ventas: [], meli_notify_log: [] });
  let llamadas = 0;
  const opciones = { listar: async () => ['9'], procesar: async () => { llamadas++; } };   // sin vincular: no inserta
  const r1 = await sincronizarOrdenes(s, opciones);
  assert.deepStrictEqual(r1.procesadas.map(p => p.registrada), [false]);
  assert.match(s._tablas.meli_notify_log[0].error, /no se registró/);

  const r2 = await sincronizarOrdenes(s, opciones);
  assert.strictEqual(llamadas, 1, 'la segunda corrida no la vuelve a mandar');
  assert.deepStrictEqual(r2.procesadas, []);
});

test('si el webhook falla con una orden, queda anotado y sigue con las demás', async () => {
  const s = fakeSupabase({ ventas: [], meli_notify_log: [] });
  const r = await sincronizarOrdenes(s, {
    listar: async () => ['5', '6'],
    procesar: async (id) => {
      if (id === '5') throw new Error('MELI 500');
      s._tablas.ventas.push({ id: 'V6', orden_meli: '6' });
    },
  });
  assert.deepStrictEqual(r.procesadas.map(p => [p.orden, p.registrada, p.error]), [['5', false, 'MELI 500'], ['6', true, null]]);
  assert.strictEqual(s._tablas.meli_notify_log.find(l => l.resource === '5').error, 'MELI 500');
});

test('sin órdenes recientes no toca nada', async () => {
  const s = fakeSupabase({});
  assert.deepStrictEqual(await sincronizarOrdenes(s, { listar: async () => [], procesar: async () => {} }),
    { revisadas: 0, ya_estaban: 0, procesadas: [] });
  assert.deepStrictEqual(Object.keys(s._tablas), []);
});
