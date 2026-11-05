// Comisión MELI = cargos por venta + cobro de envío − bonificación de envío.
//
// Los casos son ventas reales del 2/11 (MLU), con lo que devuelve /shipments/{id}/costs y lo
// que muestra el panel de MELI:
//   · Espejos, Mercado Envíos con envío gratis: $1.373 − $205,95 cargos − $135 envío = $1.032,05
//   · Puños, Mercado Envíos, paga el comprador: $414,68 − $77,20 cargos − $0 envío  = $337,48
//   · Espejos, Flex con envío gratis:           $1.458 − $218,70 cargos + $33,80 bonif. = $1.273,10
//   · Manillar, Flex, paga el comprador:        $820,14 − $163,02 cargos + $200 envío = $857,12

const { test } = require('node:test');
const assert = require('node:assert');
const { ajusteEnvio, envioDeLinea, comisionConEnvio } = require('../api/meli/_envioMeli');

const VENDEDOR = 2715667241;
const remitente = (extra) => ({ senders: [{ user_id: VENDEDOR, charges: { charge_flex: 0 }, cost: 0, save: 0, ...extra }] });

const meGratis = {
  ship: { logistic_type: 'xd_drop_off', sender_id: VENDEDOR, base_cost: 270, order_cost: 1373,
    shipping_option: { list_cost: 135, cost: 0 } },
  costs: remitente({ cost: 135, save: 135 }),
};
const mePagaComprador = {
  ship: { logistic_type: 'xd_drop_off', sender_id: VENDEDOR, base_cost: 255, order_cost: 414.68,
    shipping_option: { list_cost: 255, cost: 255 } },
  costs: remitente({ cost: 0, save: 0 }),
};
const flexGratis = {
  ship: { logistic_type: 'self_service', sender_id: VENDEDOR, base_cost: 169, order_cost: 1458,
    shipping_option: { list_cost: 135.2, cost: 0 } },
  costs: remitente({ cost: 135.2, save: 33.8 }),
};
const flexPagaComprador = {
  ship: { logistic_type: 'self_service', sender_id: VENDEDOR, base_cost: 200, order_cost: 820.14,
    shipping_option: { list_cost: 200, cost: 200 } },
  costs: { ...remitente({ cost: 0, save: 0 }),
    receiver: { cost: 200, cost_details: [{ sender_id: VENDEDOR, amount: 200 }] } },
};

const neto = (total, cargos, c) => {
  const envio = envioDeLinea(c.ship, c.costs, total, total);
  const comision = comisionConEnvio({ cargos, saleFee: cargos, envio });
  return { envio, comision, neto: Math.round((total - comision) * 100) / 100 };
};

test('Mercado Envíos con envío gratis: se suma lo que paga el vendedor, como en el panel', () => {
  assert.deepStrictEqual(neto(1373, 205.95, meGratis), { envio: 135, comision: 340.95, neto: 1032.05 });
});

test('Mercado Envíos pagado por el comprador: sólo los cargos por venta', () => {
  assert.deepStrictEqual(neto(414.68, 77.2, mePagaComprador), { envio: 0, comision: 77.2, neto: 337.48 });
});

test('Flex con envío gratis: la bonificación baja la comisión, como en el panel', () => {
  assert.deepStrictEqual(neto(1458, 218.7, flexGratis), { envio: -33.8, comision: 184.9, neto: 1273.1 });
});

test('Flex pagado por el comprador: el envío que pagó le llega al vendedor, como en el panel', () => {
  // La comisión queda negativa: MELI le pasa más de lo que le cobra, y total − comisión = cobrado.
  assert.deepStrictEqual(neto(820.14, 163.02, flexPagaComprador), { envio: -200, comision: -36.98, neto: 857.12 });
});

test('sin /costs se usa el shipment y da lo mismo', () => {
  assert.strictEqual(ajusteEnvio(meGratis.ship, null), 135);
  assert.strictEqual(ajusteEnvio(mePagaComprador.ship, null), 0);
  assert.strictEqual(ajusteEnvio(flexGratis.ship, null), -33.8);
  assert.strictEqual(ajusteEnvio(flexPagaComprador.ship, null), -200);
});

test('ventas sin shipment no tocan la comisión', () => {
  assert.strictEqual(ajusteEnvio(null, null), 0);
  assert.strictEqual(ajusteEnvio({ logistic_type: 'xd_drop_off' }, null), 0);
});

test('un carrito reparte un solo envío entre sus órdenes', () => {
  // Dos órdenes del mismo pack, $1.000 y $500, un envío de $150: no se cobra dos veces.
  const ship = { logistic_type: 'xd_drop_off', order_cost: 1500, shipping_option: { list_cost: 150, cost: 0 } };
  assert.strictEqual(envioDeLinea(ship, null, 1000, 1000), 100);
  assert.strictEqual(envioDeLinea(ship, null, 500, 500), 50);
});

test('si el neto del pago ya trae el envío, no se suma dos veces', () => {
  assert.strictEqual(comisionConEnvio({ cargos: 340.95, saleFee: 205.95, envio: 135 }), 340.95);
});

test('lo que MELI le pasa al vendedor nunca se compara contra el neto del pago', () => {
  assert.strictEqual(comisionConEnvio({ cargos: 10, saleFee: 10, envio: -33.8 }), -23.8);
});
