// Lo que no pasa por la pantalla, directo sobre los módulos de api/meli (sin navegador):
//   · el cuerpo que se le manda a Mercado Ads al cambiar una campaña (la pantalla habla en
//     ROAS y MELI en ACOS: un error en la conversión deja la campaña perdiendo plata);
//   · el "antes y después" de un cambio, que es lo que dice si el cambio sirvió;
//   · la semana a la que cae cada día en la evolución por segmento.

const { test } = require('node:test');
const assert = require('node:assert');
const { cuerpoCampana } = require('../api/meli/ads-acciones');
const { antesYDespues } = require('../api/meli/_adsCambios');
const { lunesDe } = require('../api/meli/ads-evolucion');

test('el ROAS objetivo se manda como ACOS objetivo: ROAS 4x = ACOS 25%', () => {
  assert.deepStrictEqual(cuerpoCampana({ roas_objetivo: 4 }), { acos_target: 25 });
  assert.deepStrictEqual(cuerpoCampana({ roas_objetivo: 3 }), { acos_target: 33.33 });
  assert.deepStrictEqual(cuerpoCampana({ presupuesto: 350, estado: 'paused' }), { budget: 350, status: 'paused' });
});

test('los valores que no tienen sentido no llegan a MELI', () => {
  assert.throws(() => cuerpoCampana({ presupuesto: 0 }), /mayor a 0/);
  assert.throws(() => cuerpoCampana({ roas_objetivo: -2 }), /mayor a 0/);
  assert.throws(() => cuerpoCampana({ estado: 'borrada' }), /Estado inválido/);
  assert.throws(() => cuerpoCampana({}), /nada para cambiar/);
});

// Snapshot de una campaña: 14 días antes a $100/día con 1 venta cada 2 días, y después a
// $200/día con 2 ventas por día. Cada venta deja $300 antes de ads.
function snapshotDe(fechaCambio, diasDespues) {
  const filas = [];
  const dia = n => new Date(new Date(fechaCambio + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  for (let i = -14; i < 0; i++) {
    filas.push({ fecha: dia(i), campaign_id: 'C1', ad_group_id: 'G1', sku: 'A', spend: 100, facturacion: 500 * (i % 2 ? 1 : 0), unidades: i % 2 ? 1 : 0 });
  }
  for (let i = 0; i < diasDespues; i++) {
    filas.push({ fecha: dia(i), campaign_id: 'C1', ad_group_id: 'G1', sku: 'A', spend: 200, facturacion: 1000, unidades: 2 });
  }
  // Otra campaña el mismo día: no tiene que contarse.
  filas.push({ fecha: dia(0), campaign_id: 'C2', ad_group_id: 'G9', sku: 'A', spend: 9999, facturacion: 0, unidades: 0 });
  return filas;
}

test('el antes y después compara por día y dice si la ganancia mejoró', () => {
  const contrib = new Map([['A', 300]]);
  const r = antesYDespues({ fecha: '2026-09-01', nivel: 'campana', campaign_id: 'C1' },
    snapshotDe('2026-09-01', 14), contrib, '2026-10-16');
  assert.strictEqual(r.antes.dias, 14);
  assert.strictEqual(r.antes.inversion, 1400);
  assert.strictEqual(r.antes.unidades, 7);
  assert.strictEqual(r.antes.ganancia_dia, (7 * 300 - 1400) / 14);
  assert.strictEqual(r.despues.dias, 14);
  assert.strictEqual(r.despues.ganancia_dia, 2 * 300 - 200);
  assert.strictEqual(r.veredicto, 'mejoro');
});

test('un cambio reciente no se juzga: menos de 7 días de después es esperar', () => {
  const r = antesYDespues({ fecha: '2026-10-13', nivel: 'campana', campaign_id: 'C1' },
    snapshotDe('2026-10-13', 3), new Map([['A', 300]]), '2026-10-16');
  assert.strictEqual(r.despues.dias, 3, 'del 13 al 15: hoy todavía no está consolidado');
  assert.strictEqual(r.veredicto, 'esperando');
});

test('un cambio de anuncio mira sólo ese anuncio', () => {
  const r = antesYDespues({ fecha: '2026-09-01', nivel: 'anuncio', ad_group_id: 'G9' },
    snapshotDe('2026-09-01', 14), new Map([['A', 300]]), '2026-10-16');
  assert.strictEqual(r.antes.inversion, 0);
  assert.strictEqual(r.despues.inversion, 9999);
});

test('cada día cae en el lunes de su semana', () => {
  assert.strictEqual(lunesDe('2026-10-12'), '2026-10-12');   // lunes
  assert.strictEqual(lunesDe('2026-10-16'), '2026-10-12');   // viernes
  assert.strictEqual(lunesDe('2026-10-18'), '2026-10-12');   // domingo
});
