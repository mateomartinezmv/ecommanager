// El día de una venta en hora de Montevideo (api/_fechas.js), que es el que usa el resumen de
// las 10:00 para cortar de 00:00 a 23:59.
//
// Lo que se protege: MELI manda los horarios en -04:00, así que una venta de las 00:30 de
// Uruguay llega como 23:30 del día anterior y quedaba en ese día. Shopify los manda en la zona
// de la tienda.

const { test } = require('node:test');
const assert = require('node:assert');
const { fechaEnUruguay } = require('../api/_fechas');

test('MELI: una venta de las 00:30 de Uruguay es de ese día, no del anterior', () => {
  assert.strictEqual(fechaEnUruguay('2026-11-15T23:30:00.000-04:00'), '2026-11-16');
  assert.strictEqual(fechaEnUruguay('2026-11-15T22:59:00.000-04:00'), '2026-11-15');
  assert.strictEqual(fechaEnUruguay('2026-11-15T10:00:00.000-04:00'), '2026-11-15');
});

test('Shopify y cualquier otra zona: siempre el día de Montevideo', () => {
  assert.strictEqual(fechaEnUruguay('2026-11-15T23:59:00-03:00'), '2026-11-15');
  assert.strictEqual(fechaEnUruguay('2026-11-16T02:30:00Z'), '2026-11-15');
  assert.strictEqual(fechaEnUruguay('2026-11-16T03:00:00Z'), '2026-11-16');
});

test('sin fecha o con una que no se entiende: hoy en Montevideo', () => {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date());
  assert.strictEqual(fechaEnUruguay(undefined), hoy);
  assert.strictEqual(fechaEnUruguay('cualquier cosa'), hoy);
});
