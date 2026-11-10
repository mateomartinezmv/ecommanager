// Descuentos de MELI → Shopify (api/shopify/_descuentos.js).
//
// Lo que se protege: que en Shopify quede el precio de lista de MELI como precio de
// comparación y el precio final como precio; que, si las publicaciones de un mismo SKU
// tienen el descuento a precios distintos, mande el precio final más alto; y que un SKU sin
// descuento activo no se toque.

const { test } = require('node:test');
const assert = require('node:assert');
const { descuentoDelSku, armarPlan } = require('../api/shopify/_descuentos');

const pub = (meli_id, precio, precio_lista, extra = {}) => ({
  meli_id, estado: 'active',
  descuento: precio == null ? null : { tipo: 'DEAL', nombre: 'Ciberlunes', precio, precio_lista, finish_date: '2026-11-11T23:00:00-03:00' },
  ...extra,
});

test('una sola publicación con descuento: precio final y precio de lista', () => {
  const d = descuentoDelSku([pub('MLU1', 1188.74, 1290)]);
  assert.strictEqual(d.precio, '1188.74');
  assert.strictEqual(d.precio_lista, '1290.00');
  assert.strictEqual(d.porcentaje, 8);
  assert.strictEqual(d.precios_distintos, false);
});

test('varias publicaciones del mismo SKU a precios distintos: manda el precio final más alto', () => {
  const d = descuentoDelSku([pub('MLU1228703706', 866, 990), pub('MLU1504894960', 856.12, 990)]);
  assert.strictEqual(d.meli_id, 'MLU1228703706');
  assert.strictEqual(d.precio, '866.00');
  assert.strictEqual(d.precio_lista, '990.00');
  assert.strictEqual(d.precios_distintos, true);
});

test('la más cara gana aunque no sea la principal', () => {
  const d = descuentoDelSku([pub('MLU1', 800, 1000), pub('MLU2', 900, 1000)]);
  assert.strictEqual(d.meli_id, 'MLU2');
  assert.strictEqual(d.precio, '900.00');
});

test('publicaciones sin descuento o pausadas no cuentan', () => {
  assert.strictEqual(descuentoDelSku([pub('MLU1', null, null)]), null);
  assert.strictEqual(descuentoDelSku([pub('MLU1', 900, 1000, { estado: 'paused' })]), null);
  // Un "descuento" que no baja el precio no es descuento.
  assert.strictEqual(descuentoDelSku([pub('MLU1', 1000, 1000)]), null);
  // La que no tiene descuento no le gana a la que sí, aunque su precio sea más alto.
  const d = descuentoDelSku([pub('MLU1', null, null), pub('MLU2', 900, 1000)]);
  assert.strictEqual(d.meli_id, 'MLU2');
});

test('plan: compara contra Shopify y separa lo que no está enlazado', () => {
  const productos = [
    { sku: 'A', nombre: 'Con cambio', variantId: '1', publicaciones: [pub('MLU1', 900, 1000)] },
    { sku: 'B', nombre: 'Ya al día', variantId: '2', publicaciones: [pub('MLU2', 450.5, 500)] },
    { sku: 'C', nombre: 'Sin descuento', variantId: '3', publicaciones: [pub('MLU3', null, null)] },
    { sku: 'D', nombre: 'Sin Shopify', variantId: null, publicaciones: [pub('MLU4', 90, 100)] },
  ];
  const shopify = {
    1: { productId: '10', titulo: 'A', precio: '1000.00', compare_at: null },
    2: { productId: '20', titulo: 'B', precio: '450.50', compare_at: '500.00' },
    3: { productId: '30', titulo: 'C', precio: '700.00', compare_at: null },
  };
  const { filas, sinShopify } = armarPlan(productos, shopify);

  assert.deepStrictEqual(filas.map(f => f.sku), ['A', 'B']);
  const a = filas.find(f => f.sku === 'A');
  assert.deepStrictEqual(a.actual, { precio: '1000.00', compare_at: null });
  assert.deepStrictEqual(a.nuevo, { precio: '900.00', compare_at: '1000.00' });
  assert.strictEqual(a.alDia, false);
  assert.strictEqual(filas.find(f => f.sku === 'B').alDia, true);
  assert.deepStrictEqual(sinShopify.map(x => x.sku), ['D']);
});

const { parsearPrecios } = require('../api/shopify/_descuentos');

test('precios a mano: sin tachado se borra, con tachado se respeta', () => {
  assert.deepStrictEqual(parsearPrecios('HP-Q0211:890, ALERONFINOSNK:1490,X:900:990'), [
    { sku: 'HP-Q0211', nuevo: { precio: '890.00', compare_at: null } },
    { sku: 'ALERONFINOSNK', nuevo: { precio: '1490.00', compare_at: null } },
    { sku: 'X', nuevo: { precio: '900.00', compare_at: '990.00' } },
  ]);
  assert.deepStrictEqual(parsearPrecios([{ sku: 'A', precio: 450 }]), [{ sku: 'A', nuevo: { precio: '450.00', compare_at: null } }]);
});

test('precios a mano: un precio inválido o un SKU repetido no toca nada', () => {
  assert.throws(() => parsearPrecios('A:0'));
  assert.throws(() => parsearPrecios('A:abc'));
  assert.throws(() => parsearPrecios('A:100,A:200'));
  assert.throws(() => parsearPrecios(':100'));
});
