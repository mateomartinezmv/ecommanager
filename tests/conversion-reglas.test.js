// La tasa de conversión por producto en MELI (api/meli/_conversion.js), sin red.
//
// Lo que se protege: que las visitas y las ventas de la original y de los ángulos se sumen
// (es el mismo producto), que una publicación sin dato de visitas no cuente como 0 visitas,
// y que el orden ponga primero lo que se ve y no se compra.

const { test } = require('node:test');
const assert = require('node:assert');
const { armarFilas, rango, VISITAS_MINIMAS } = require('../api/meli/_conversion');

const prod = (sku, ids, extra = {}) => ({ sku, nombre: sku, meli_ids: ids, discontinuado: false, ...extra });
const venta = (sku, cantidad, extra = {}) => ({ sku, cantidad, canal: 'meli', estado: 'pagada', ...extra });

test('suma visitas y ventas de la original y los ángulos', () => {
  const [f] = armarFilas({
    productos: [prod('A', ['M1', 'M2', 'M3'])],
    visitasPorItem: { M1: 100, M2: 50, M3: 50 },
    ventas: [venta('A', 2), venta('A', 1), venta('B', 9)],
    skusConFotos: [],
  });
  assert.strictEqual(f.visitas, 200);
  assert.strictEqual(f.vendidas, 3);
  assert.strictEqual(f.conversion, 0.015);
});

test('ordena de menor a mayor conversión; sin visitas, al final', () => {
  const filas = armarFilas({
    productos: [prod('ALTA', ['A']), prod('BAJA', ['B']), prod('NADIE', ['C']), prod('SINDATO', ['D']), prod('CERO', ['E'])],
    visitasPorItem: { A: 100, B: 100, C: 0, E: 300 },
    ventas: [venta('ALTA', 5), venta('BAJA', 1)],
    skusConFotos: [],
  });
  assert.deepStrictEqual(filas.map(f => f.sku), ['CERO', 'BAJA', 'ALTA', 'NADIE', 'SINDATO']);
  const sinDato = filas.find(f => f.sku === 'SINDATO');
  assert.strictEqual(sinDato.visitas, null, 'sin dato no es 0 visitas');
  assert.strictEqual(sinDato.conversion, null);
});

test('no cuenta ventas canceladas, ni de otros canales; marca las pocas visitas y las fotos nuevas', () => {
  const [f] = armarFilas({
    productos: [prod('A', ['M1'])],
    visitasPorItem: { M1: VISITAS_MINIMAS - 1 },
    ventas: [venta('A', 1), venta('A', 5, { estado: 'cancelada' }), venta('A', 7, { canal: 'mostrador' })],
    skusConFotos: ['A'],
  });
  assert.strictEqual(f.vendidas, 1);
  assert.strictEqual(f.pocas_visitas, true);
  assert.strictEqual(f.fotos_nuevas, true);
});

test('deja afuera lo descatalogado y lo que no está en MELI', () => {
  const filas = armarFilas({
    productos: [prod('A', ['M1']), prod('B', ['M2'], { discontinuado: true }), prod('C', [])],
    visitasPorItem: { M1: 10, M2: 10 },
    ventas: [],
    skusConFotos: [],
  });
  assert.deepStrictEqual(filas.map(f => f.sku), ['A']);
});

test('el rango de fechas es en UTC y de largo exacto', () => {
  assert.deepStrictEqual(rango(30, new Date('2026-11-11T02:00:00Z')), { desde: '2026-10-12', hasta: '2026-11-11' });
});
