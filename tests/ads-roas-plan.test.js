// En qué campaña de ROAS objetivo va cada producto (api/meli/_adsRoasPlan.js).
//
// Los casos salen de los números reales del 18/10 al 17/11/2026: los espejos alerón (54% de
// margen) aguantan la campaña de 4x; los espejos de puño (38%) en 4x perdían plata en cada
// venta que traía el anuncio y van a una más exigente.

const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../api/meli/_adsRoasPlan');

test('ROAS necesario: deja el colchón después de pagar Ads con IVA', () => {
  // 1,22 / (0,54 − 0,15) = 3,13
  assert.strictEqual(P.roasNecesario(54, 15), 3.13);
  assert.strictEqual(P.roasNecesario(38, 15), 5.3);
  // Sin margen por encima del colchón no hay ROAS que alcance.
  assert.strictEqual(P.roasNecesario(15, 15), null);
  assert.strictEqual(P.roasNecesario(10, 15), null);
});

test('el ROAS de la campaña sale de su ACOS objetivo', () => {
  assert.strictEqual(P.roasDeCampana(25), 4);
  assert.strictEqual(P.roasDeCampana(25.64), 3.9);
  assert.strictEqual(P.roasDeCampana(20), 5);
  assert.strictEqual(P.roasDeCampana(0), null);
});

test('margen alto va en 4x; margen medio sube de escalón', () => {
  const grande = P.destinoRoas({ margen: 53.6, stock: 30, stock_dep: 30, unidades_mes: 10 });
  assert.strictEqual(grande.destino, 4);
  const porta = P.destinoRoas({ margen: 41.1, stock: 19, stock_dep: 19, unidades_mes: 19 });
  assert.strictEqual(porta.destino, 5);          // necesita 4,67x
  const puno = P.destinoRoas({ margen: 38.1, stock: 6, stock_dep: 6, unidades_mes: 3 });
  assert.strictEqual(puno.destino, 6);           // necesita 5,28x
  assert.match(puno.motivo, /ROAS 5\.28x/);
});

test('con más colchón los productos suben de escalón', () => {
  assert.strictEqual(P.destinoRoas({ margen: 53.6, stock: 9, stock_dep: 9, unidades_mes: 2 }, { colchon: 25 }).destino, 5);
  assert.strictEqual(P.destinoRoas({ margen: 38.1, stock: 6, stock_dep: 6, unidades_mes: 3 }, { colchon: 25 }).destino, 'no_anunciar');
});

test('margen que no alcanza ni para la campaña más exigente: no anunciar', () => {
  // Guardabarros: 25,5% de margen → 1,22 / 0,105 = 11,6x.
  const r = P.destinoRoas({ margen: 25.5, stock: 20, stock_dep: 20, unidades_mes: 9 });
  assert.strictEqual(r.destino, 'no_anunciar');
  assert.strictEqual(r.roas_necesario, 11.62);
  assert.match(r.motivo, /Subí el precio/);
  // Sin margen por encima del colchón, tampoco.
  assert.strictEqual(P.destinoRoas({ margen: 8, stock: 3, stock_dep: 3, unidades_mes: 1 }).destino, 'no_anunciar');
});

test('se vende solo y se está por agotar: pausar hasta reponer', () => {
  // Espejo alerón grande: 10 unidades y ~23 por mes → ~13 días.
  const r = P.destinoRoas({ margen: 53.6, stock: 10, stock_dep: 10, unidades_mes: 23 });
  assert.strictEqual(r.destino, 'pausar');
  assert.strictEqual(r.dias_stock, 13);
  // Poco stock pero se vende poco: no es "se agota solo", se juzga por margen.
  assert.strictEqual(P.destinoRoas({ margen: 53.6, stock: 3, stock_dep: 3, unidades_mes: 4 }).destino, 4);
});

test('sin stock no hay nada que anunciar', () => {
  assert.strictEqual(P.destinoRoas({ margen: 52, stock: 0, stock_dep: 0, unidades_mes: 19 }).destino, 'sin_stock');
});
