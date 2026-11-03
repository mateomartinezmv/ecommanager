// Las etiquetas de MELI de varios envíos (Control de despacho → 🖨️), del lado del servidor y
// sin red: de qué shipment es cada envío del CRM, qué dice MELI de cada etiqueta, y lo que
// el endpoint le pide a MELI y le devuelve a la pantalla.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { shipmentsDeEnvios, estadoEtiqueta, estadosDeEtiquetas, mensajeDeMeli } = require('../api/meli/_etiquetas');

function supabaseFalso(db, { sinColumna = false } = {}) {
  const writes = [];
  if (sinColumna) db.envios.forEach(r => delete r.meli_shipment_id);
  return {
    writes,
    from(tabla) {
      const q = { filtros: [], fila: null };
      const b = {
        select: () => b,
        in: (c, vs) => { q.filtros.push(r => vs.includes(r[c])); return b; },
        eq: (c, v) => { q.filtros.push(r => r[c] === v); return b; },
        update: f => { q.fila = f; return b; },
        then: (ok, ko) => {
          if (q.fila && sinColumna && 'meli_shipment_id' in q.fila) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column envios.meli_shipment_id does not exist' } }).then(ok, ko);
          }
          const filas = db[tabla].filter(r => q.filtros.every(f => f(r)));
          if (q.fila) { filas.forEach(r => Object.assign(r, q.fila)); writes.push({ fila: q.fila, ids: filas.map(r => r.id) }); }
          return Promise.resolve({ data: filas.map(r => ({ ...r })), error: null }).then(ok, ko);
        },
      };
      return b;
    },
  };
}

const base = () => ({
  envios: [
    { id: 'E_GUARDADO', orden: '1', tracking: null, meli_shipment_id: '44000000001' },
    { id: 'E_TRACKING', orden: '2', tracking: 'MEL48412750656FMDOF01', meli_shipment_id: null },
    { id: 'E_FLEX', orden: '3', tracking: 'RLX6W3ZYEVLA7AV74YRRYZGI5I', meli_shipment_id: null },
    { id: 'E_SIN', orden: null, tracking: null, meli_shipment_id: null },
  ],
});
const ordenes = { 3: '44000000003' };
const deps = { shipmentIdDeOrden: async (token, orden) => ordenes[orden] || null };

test('cada envío se traduce a su shipment de MELI, y lo que se resuelve se guarda', async () => {
  const db = base();
  const sb = supabaseFalso(db);
  const r = await shipmentsDeEnvios(sb, 'T', ['E_GUARDADO', 'E_TRACKING', 'E_FLEX', 'E_SIN', 'E_NO_EXISTE'], deps);
  assert.deepStrictEqual(r, [
    { envioId: 'E_GUARDADO', shipmentId: '44000000001' },
    { envioId: 'E_TRACKING', shipmentId: '48412750656' },
    { envioId: 'E_FLEX', shipmentId: '44000000003' },
    { envioId: 'E_SIN', shipmentId: null },
    { envioId: 'E_NO_EXISTE', shipmentId: null },
  ]);
  assert.deepStrictEqual(sb.writes.map(w => [w.ids[0], w.fila.meli_shipment_id]),
    [['E_TRACKING', '48412750656'], ['E_FLEX', '44000000003']]);
});

test('sin la columna también resuelve, sin intentar guardar', async () => {
  const sb = supabaseFalso(base(), { sinColumna: true });
  const r = await shipmentsDeEnvios(sb, 'T', ['E_TRACKING', 'E_FLEX'], deps);
  assert.deepStrictEqual(r.map(x => x.shipmentId), ['48412750656', '44000000003']);
  assert.deepStrictEqual(sb.writes, []);
});

test('qué etiqueta está impresa y cuál entrega MELI', () => {
  assert.deepStrictEqual(estadoEtiqueta({ status: 'ready_to_ship', substatus: 'ready_to_print' }),
    { status: 'ready_to_ship', substatus: 'ready_to_print', impresa: false, imprimible: true });
  assert.deepStrictEqual(estadoEtiqueta({ status: 'ready_to_ship', substatus: 'printed' }),
    { status: 'ready_to_ship', substatus: 'printed', impresa: true, imprimible: true });
  // Ya la retiró el transportista: estuvo impresa, pero ya no hace falta.
  assert.deepStrictEqual(estadoEtiqueta({ status: 'ready_to_ship', substatus: 'picked_up', status_history: { date_first_printed: '2026-11-03' } }),
    { status: 'ready_to_ship', substatus: 'picked_up', impresa: true, imprimible: false });
  assert.strictEqual(estadoEtiqueta({ status: 'pending', substatus: 'buffered' }).imprimible, false);
  assert.strictEqual(estadoEtiqueta({ status: 'shipped' }).imprimible, false);
});

test('el estado de cada envío, también cuando falta el shipment o MELI no contesta', async () => {
  const estados = await estadosDeEtiquetas('T', [
    { envioId: 'A', shipmentId: '1' }, { envioId: 'B', shipmentId: '2' }, { envioId: 'C', shipmentId: null },
  ], { obtenerShipment: async (t, id) => (id === '1' ? { status: 'ready_to_ship', substatus: 'printed' } : null) });
  assert.deepStrictEqual(estados.A, { shipmentId: '1', status: 'ready_to_ship', substatus: 'printed', impresa: true, imprimible: true });
  assert.deepStrictEqual(estados.B, { shipmentId: '2', impresa: false, imprimible: false, motivo: 'meli_no_responde' });
  assert.deepStrictEqual(estados.C, { shipmentId: null, impresa: false, imprimible: false, motivo: 'sin_shipment' });
});

test('el error de MELI se muestra con su causa', () => {
  assert.strictEqual(mensajeDeMeli({ message: 'Shipments not ready', cause: [{ message: '48412750656 is shipped' }] }, 400),
    'Shipments not ready — 48412750656 is shipped');
  assert.strictEqual(mensajeDeMeli(null, 503), 'MELI respondió 503');
});

// ── El endpoint, con Supabase, el token y MELI reemplazados ───────────────────
let dbActual = null;
require.cache[require.resolve(path.join(__dirname, '../api/_supabase'))] = { exports: { getSupabase: () => supabaseFalso(dbActual) } };
require.cache[require.resolve(path.join(__dirname, '../api/_meliToken'))] = { exports: { getMeliToken: async () => 'TOKEN' } };
const handler = require('../api/meli/etiqueta');

async function llamar(query, meli) {
  const pedidos = [];
  const fetchOriginal = global.fetch;
  global.fetch = async (url) => { pedidos.push(String(url)); return meli(String(url)); };
  const res = {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
    json(d) { this.body = d; return this; }, send(b) { this.body = b; return this; }, redirect() { return this; },
  };
  try { await handler({ method: 'GET', query }, res); } finally { global.fetch = fetchOriginal; }
  return { res, pedidos };
}
const respuesta = (tipo, cuerpo, status = 200) => ({
  ok: status < 400, status, headers: { get: () => tipo },
  json: async () => cuerpo, arrayBuffer: async () => Buffer.from(String(cuerpo)),
});

test('el PDF se pide en un solo llamado con los shipments y avisa los que quedaron afuera', async () => {
  dbActual = base();
  const { res, pedidos } = await llamar({ envios: 'E_GUARDADO,E_TRACKING,E_SIN' }, () => respuesta('application/pdf', '%PDF'));
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(pedidos, ['https://api.mercadolibre.com/shipment_labels?shipment_ids=44000000001,48412750656&response_type=pdf']);
  assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
  assert.strictEqual(res.headers['X-Etiquetas-Omitidas'], 'E_SIN');
});

test('si MELI responde con un error, el endpoint lo devuelve explicado', async () => {
  dbActual = base();
  const { res } = await llamar({ envios: 'E_GUARDADO' }, () => respuesta('application/json', { message: 'not ready to print' }, 400));
  assert.strictEqual(res.code, 502);
  assert.match(res.body.error, /MELI no entregó las etiquetas: not ready to print/);
});

test('sin ningún shipment no le pregunta nada a MELI', async () => {
  dbActual = base();
  const { res, pedidos } = await llamar({ envios: 'E_SIN' }, () => { throw new Error('no debería llamar'); });
  assert.strictEqual(res.code, 404);
  assert.deepStrictEqual(pedidos, []);
});

test('el estado devuelve lo de cada envío', async () => {
  dbActual = base();
  const { res } = await llamar({ envios: 'E_GUARDADO,E_SIN', estado: '1' },
    () => respuesta('application/json', { id: 44000000001, status: 'ready_to_ship', substatus: 'ready_to_print' }));
  assert.strictEqual(res.body.estados.E_GUARDADO.imprimible, true);
  assert.strictEqual(res.body.estados.E_GUARDADO.impresa, false);
  assert.strictEqual(res.body.estados.E_SIN.motivo, 'sin_shipment');
});
