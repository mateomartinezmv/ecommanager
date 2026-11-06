// Cargos por venta de MELI: nunca $0.
//
// El aviso de la orden a veces llega sin sale_fee y sin el neto del pago. El CRM guardaba
// entonces $0 de cargos y la comisión quedaba igual al envío (la venta de $1.126 del 5/11:
// comisión $135 = envío $135). Se protege que se use el primer dato que MELI tenga
// (pago → sale_fee → marketplace_fee → tabla de tarifas), que la tabla se consulte con el
// precio, el tipo de publicación y la categoría, y que el cron detecte esas ventas.

const { test } = require('node:test');
const assert = require('node:assert');
const { cargosDeLinea } = require('../api/meli/_cargosMeli');
const { sinCargos } = require('../api/meli/recalcular-comisiones');

const item = (extra = {}) => ({
  item: { id: 'MLU1504461644', category_id: 'MLU1234' }, quantity: 1, unit_price: 1126,
  listing_type_id: 'gold_special', ...extra,
});
const orden = (it, payments = []) => ({ id: 2000019357136558, order_items: [it], payments });
const sinRed = () => { throw new Error('no tendría que consultar la tabla de tarifas'); };

test('el sale_fee del ítem es por unidad', async () => {
  const it = item({ sale_fee: 168.9, quantity: 2, unit_price: 1126 });
  const r = await cargosDeLinea({ order: orden(it), item: it, fetchImpl: sinRed });
  assert.deepStrictEqual(r, { cargos: 337.8, saleFee: 337.8, fuente: 'sale_fee' });
});

test('si el pago trae el neto, manda lo que descontó MELI', async () => {
  const it = item({ sale_fee: 168.9 });
  const r = await cargosDeLinea({ order: orden(it, [{ status: 'approved', net_received_amount: 960 }]), item: it, fetchImpl: sinRed });
  assert.strictEqual(r.cargos, 166);
  assert.strictEqual(r.fuente, 'pago');
});

test('sin sale_fee ni neto, usa el marketplace_fee del pago', async () => {
  const it = item({ sale_fee: 0 });
  const r = await cargosDeLinea({ order: orden(it, [{ status: 'approved', marketplace_fee: 168.9 }]), item: it, fetchImpl: sinRed });
  assert.deepStrictEqual(r, { cargos: 168.9, saleFee: 0, fuente: 'marketplace_fee' });
});

test('sin nada en la orden, consulta la tabla de tarifas de MELI', async () => {
  const it = item({ sale_fee: null });
  let url;
  const fetchImpl = async (u) => {
    url = u;
    return { ok: true, json: async () => [
      { listing_type_id: 'gold_pro', sale_fee_amount: 214 },
      { listing_type_id: 'gold_special', sale_fee_amount: 168.9 },
    ] };
  };
  const r = await cargosDeLinea({ order: orden(it), item: it, token: 'T', fetchImpl });
  assert.deepStrictEqual(r, { cargos: 168.9, saleFee: 168.9, fuente: 'listing_prices' });
  assert.match(url, /\/sites\/MLU\/listing_prices\?/);
  assert.match(url, /price=1126/);
  assert.match(url, /listing_type_id=gold_special/);
  assert.match(url, /category_id=MLU1234/);
});

test('si MELI no da ningún dato, queda en 0 marcado como sin dato (no inventa)', async () => {
  const it = item({ sale_fee: 0 });
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  const r = await cargosDeLinea({ order: orden(it), item: it, fetchImpl });
  assert.deepStrictEqual(r, { cargos: 0, saleFee: 0, fuente: 'sin_dato' });
});

test('el cron reconoce las ventas que quedaron sin cargos por venta', () => {
  assert.strictEqual(sinCargos({ comision: '135.00', costo_envio_meli: '135' }), true);
  assert.strictEqual(sinCargos({ comision: '-33.80', costo_envio_meli: '-33.8' }), true);
  assert.strictEqual(sinCargos({ comision: '0.00', costo_envio_meli: null }), true);
  assert.strictEqual(sinCargos({ comision: '353.70', costo_envio_meli: '135' }), false);
  assert.strictEqual(sinCargos({ comision: '-36.98', costo_envio_meli: '-200' }), false);
});
