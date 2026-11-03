// Comisión MELI = cargos por venta + lo que MELI cobra por el envío cuando la publicación
// tiene envío gratis.
//
// Los casos son ventas reales del 2/11 (MLU, xd_drop_off), con los números del panel de MELI:
//   · Espejos (envío gratis):   $1.373 − $205,95 cargos − $135 envío = $1.032,05
//   · Puños (paga el comprador): $414,68 − $77,20 cargos − $0 envío  = $337,48

const { test } = require('node:test');
const assert = require('node:assert');
const { envioPagadoPorVendedor, envioDeLinea, comisionConEnvio } = require('../api/meli/_envioMeli');

const envioGratis = {
  logistic_type: 'xd_drop_off', base_cost: 270, order_cost: 1373,
  shipping_option: { list_cost: 135, cost: 0 },
};
const pagaComprador = {
  logistic_type: 'xd_drop_off', base_cost: 255, order_cost: 414.68,
  shipping_option: { list_cost: 255, cost: 255 },
};

test('envío gratis en drop_off: el vendedor paga list_cost − cost, no base_cost ni 0', () => {
  assert.strictEqual(envioPagadoPorVendedor(envioGratis), 135);
});

test('si el comprador paga el envío, al vendedor no le cuesta nada', () => {
  assert.strictEqual(envioPagadoPorVendedor(pagaComprador), 0);
});

test('Flex y ventas sin shipment no suman envío MELI', () => {
  assert.strictEqual(envioPagadoPorVendedor({ ...envioGratis, logistic_type: 'self_service' }), 0);
  assert.strictEqual(envioPagadoPorVendedor(null), 0);
  assert.strictEqual(envioPagadoPorVendedor({ logistic_type: 'xd_drop_off' }), 0);
});

test('la comisión de la venta con envío gratis queda igual que el panel de MELI', () => {
  const envio = envioDeLinea(envioGratis, 1373, 1373);
  const comision = comisionConEnvio({ cargos: 205.95, saleFee: 205.95, envio });
  assert.strictEqual(envio, 135);
  assert.strictEqual(comision, 340.95);
  assert.strictEqual(Math.round((1373 - comision) * 100) / 100, 1032.05);
});

test('la venta donde paga el comprador queda sólo con los cargos por venta', () => {
  const envio = envioDeLinea(pagaComprador, 414.68, 414.68);
  assert.strictEqual(comisionConEnvio({ cargos: 77.2, saleFee: 77.2, envio }), 77.2);
});

test('un carrito reparte un solo envío entre sus órdenes', () => {
  // Dos órdenes del mismo pack, $1.000 y $500, un envío de $150: no se cobra dos veces.
  const ship = { logistic_type: 'xd_drop_off', order_cost: 1500, shipping_option: { list_cost: 150, cost: 0 } };
  assert.strictEqual(envioDeLinea(ship, 1000, 1000), 100);
  assert.strictEqual(envioDeLinea(ship, 500, 500), 50);
});

test('si el neto del pago ya trae el envío, no se suma dos veces', () => {
  assert.strictEqual(comisionConEnvio({ cargos: 340.95, saleFee: 205.95, envio: 135 }), 340.95);
});
