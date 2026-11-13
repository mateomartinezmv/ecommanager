// Las reglas del armador de promociones, sin red: qué propuesta de MELI se acepta, cuál se
// contraoferta y cuál se rechaza. Los casos salen de propuestas reales que mandó MELI
// (13 al 16 de noviembre): 28% en la pata de cabra, 31% en el soporte, 42% en el parabrisas.

const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../api/meli/_promosReglas');
const { armarPublicacion } = require('../api/meli/promos');

const promo = o => R.normalizarPromo({ status: 'candidate', id: 'P1', type: 'SMART', ...o }, o.original_price);

test('segmento: se vende solo, se vende algo (≥1 por semana) o no se vende', () => {
  assert.strictEqual(R.segmento({ costo: 342, stock: 13, vendidas60: 50 }), 'bien');      // ~16 días
  assert.strictEqual(R.segmento({ costo: 405, stock: 24, vendidas60: 23 }), 'algo');      // ~63 días
  // Soportes: stock para meses, pero se venden más de uno por semana → 15–20%, no 30%.
  assert.strictEqual(R.segmento({ costo: 88, stock: 84, vendidas60: 13 }), 'algo');
  assert.strictEqual(R.segmento({ costo: 88, stock: 85, vendidas60: 9 }), 'algo');
  // Pata de cabra y fat bars: menos de uno por semana → no se vende.
  assert.strictEqual(R.segmento({ costo: 79, stock: 16, vendidas60: 6 }), 'quieto');
  assert.strictEqual(R.segmento({ costo: 484, stock: 4, vendidas60: 4 }), 'quieto');
  assert.strictEqual(R.segmento({ costo: 153, stock: 29, vendidas60: 0 }), 'quieto');
  assert.strictEqual(R.segmento({ costo: 1000, stock: 1, vendidas60: 2, discontinuado: true }), 'liquidar');
  assert.strictEqual(R.segmento({ costo: 100, stock: 0, vendidas60: 5 }), 'sin_stock');
  assert.strictEqual(R.segmento({ costo: 0, stock: 15, vendidas60: 4 }), 'sin_costo');
});

test('límites: nunca más de 30% ni por debajo de 2 × costo', () => {
  // Parabrisas: $2.790, costo $1.000 → 2×costo = $2.000 → máximo 28,3% aunque sea liquidación.
  const p = R.limites({ precioLista: 2790, costo: 1000, seg: 'liquidar' });
  assert.ok(Math.abs(p.maximo - (1 - 2000 / 2790)) < 1e-9);
  assert.strictEqual(p.limita, 'piso');
  // Fat bar: $1.190, costo $484 → máximo 18,7%, menos que el 30% de "no se vende".
  assert.ok(R.limites({ precioLista: 1190, costo: 484, seg: 'quieto' }).maximo < 0.19);
  // Soporte: margen enorme, manda el tope del segmento.
  const s = R.limites({ precioLista: 490, costo: 88, seg: 'algo' });
  assert.strictEqual(s.maximo, 0.20);
  assert.strictEqual(s.objetivo, 0.15);
  // Nada pasa del 30%, aunque el margen dé para más.
  assert.strictEqual(R.limites({ precioLista: 990, costo: 50, seg: 'liquidar' }).maximo, 0.30);
});

test('rechaza el 42% en el parabrisas aunque sea para liquidar', () => {
  const ev = R.evaluarPromo(promo({ original_price: 2790, price: 1629.6 }), { costo: 1000, seg: 'liquidar' });
  assert.strictEqual(ev.veredicto, 'rechazar');
  assert.match(ev.motivo, /2 × costo/);
});

test('rechaza el 31% en el soporte que se vende algo; acepta un 18%', () => {
  const ctx = { costo: 88, seg: 'algo' };
  assert.strictEqual(R.evaluarPromo(promo({ original_price: 490, price: 339.5 }), ctx).veredicto, 'rechazar');
  assert.strictEqual(R.evaluarPromo(promo({ original_price: 490, price: 402 }), ctx).veredicto, 'aceptar');
});

test('acepta el 28% en la pata de cabra quieta (dentro de 25–30%)', () => {
  const ev = R.evaluarPromo(promo({ original_price: 274, price: 197.88 }), { costo: 79, seg: 'quieto' });
  assert.strictEqual(ev.veredicto, 'aceptar');
});

test('cofondeada: cuenta sólo lo que pone el vendedor', () => {
  // 35% total, MELI pone 15 → el vendedor pone 20: entra en "se vende algo".
  const p = promo({ original_price: 1000, price: 650, meli_percentage: 15, seller_percentage: 20 });
  const ev = R.evaluarPromo(p, { costo: 300, seg: 'algo' });
  assert.strictEqual(ev.veredicto, 'aceptar');
  assert.strictEqual(ev.vendedor_pct, 20);
});

test('la que paga MELI entera se acepta siempre, aunque el producto se venda solo', () => {
  const p = promo({ original_price: 1690, price: 1520, meli_percentage: 10, seller_percentage: 0 });
  assert.strictEqual(R.evaluarPromo(p, { costo: 342, seg: 'bien' }).veredicto, 'aceptar');
});

test('lo que se vende solo no entra a promos que paga el vendedor', () => {
  const ev = R.evaluarPromo(promo({ original_price: 1690, price: 1530 }), { costo: 342, seg: 'bien' });
  assert.strictEqual(ev.veredicto, 'rechazar');
  assert.match(ev.motivo, /se vende solo/i);
});

test('contraoferta: si MELI deja elegir el precio, entra con el objetivo en vez del sugerido', () => {
  // Campaña con rango: MELI sugiere 40%, acepta entre 10% y 45%. "No se vende" → objetivo 25%.
  const p = R.normalizarPromo({
    status: 'candidate', id: 'C1', type: 'DEAL', original_price: 690,
    suggested_discounted_price: 414, min_discounted_price: 380, max_discounted_price: 621,
  }, 690);
  const ev = R.evaluarPromo(p, { costo: 153, seg: 'quieto' });
  assert.strictEqual(ev.veredicto, 'contraoferta');
  assert.strictEqual(ev.deal_price, Math.ceil(690 * 0.75));
  assert.ok(ev.contra_pct <= 25);
});

test('contraoferta imposible: MELI exige más descuento que el máximo → rechazar', () => {
  const p = R.normalizarPromo({
    status: 'candidate', id: 'C2', type: 'DEAL', original_price: 1190,
    suggested_discounted_price: 800, min_discounted_price: 700, max_discounted_price: 900,
  }, 1190);
  // Fat bar: máximo 18,7% (piso) → $968 como mínimo; MELI pide como mucho $900.
  assert.strictEqual(R.evaluarPromo(p, { costo: 484, seg: 'quieto' }).veredicto, 'rechazar');
});

test('descuento propio: el objetivo del segmento, recortado por el piso y por el mínimo de MELI', () => {
  assert.deepStrictEqual(R.descuentoPropio({ precioLista: 490, costo: 88, seg: 'algo' }), { pct: 14.9, precio: 417 });
  assert.strictEqual(R.descuentoPropio({ precioLista: 1690, costo: 342, seg: 'bien' }), null);
  // Fat bar "no se vende": objetivo 25% pero el piso lo deja en 18,6%.
  const fb = R.descuentoPropio({ precioLista: 1190, costo: 484, seg: 'quieto' });
  assert.ok(fb.precio >= 968 && fb.pct < 19);
});

test('armarPublicacion: promo corriendo fuera de regla, propuestas y referencia de precio', () => {
  const prod = { costo: 88, segmento: 'algo' };
  const item = { meli_id: 'MLU1', titulo: 'Soporte', precio: 490, permalink: null };
  const pub = armarPublicacion(prod, item, [
    { id: 'V', type: 'PRICE_DISCOUNT', status: 'started', price: 300, original_price: 490 },
    { id: 'P', type: 'SMART', status: 'candidate', price: 339.5, original_price: 490 },
  ], { sugerido: 420, actual: 490, estado: 'with_benchmark_highest' });
  assert.strictEqual(pub.vigente.evaluacion.veredicto, 'rechazar');   // 38,8% corriendo
  assert.strictEqual(pub.propuestas.length, 1);
  assert.strictEqual(pub.propio, null);                                // con una corriendo no se suma otra
  assert.strictEqual(pub.referencia.baja_pct, 14.3);
  assert.strictEqual(pub.referencia.permitido, true);
  assert.strictEqual(pub.precio_minimo, 392);
});

// ── Formatos reales que devolvió MELI (13/11) ─────────────────────────────────

const { cuerpoParaAceptar } = require('../api/meli/promos');

test('relámpago con rango: el precio es el sugerido, no el `price` (que viene con 3%)', () => {
  const p = R.normalizarPromo({
    id: 'LGH-MLU1000', type: 'LIGHTNING', status: 'candidate', original_price: 274, price: 265.78,
    min_discounted_price: 54.8, max_discounted_price: 246.6, suggested_discounted_price: 232.9,
    ref_id: 'CANDIDATE-MLU1038861072-77202292965', stock: { min: 5, max: 10 },
  }, 274);
  assert.strictEqual(p.precio, 232.9);
  const ev = R.evaluarPromo(p, { costo: 79, seg: 'quieto' });
  assert.strictEqual(ev.veredicto, 'aceptar');
  assert.strictEqual(ev.deal_price, 232.9);
  const body = cuerpoParaAceptar(p, ev, 16);
  assert.deepStrictEqual(body, {
    promotion_id: 'LGH-MLU1000', promotion_type: 'LIGHTNING',
    offer_id: 'CANDIDATE-MLU1038861072-77202292965', deal_price: 232.9, stock: 10,   // tope de MELI: 10
  });
});

test('candidata PRICE_DISCOUNT sin id: se encuentra por tipo y se crea con fechas', () => {
  const p = R.normalizarPromo({
    type: 'PRICE_DISCOUNT', status: 'candidate', original_price: 690, price: 655.5,
    min_discounted_price: 138, max_discounted_price: 655.5, suggested_discounted_price: 655.5,
  }, 690);
  assert.strictEqual(p.id, null);
  assert.strictEqual(p.clave, 'PRICE_DISCOUNT');
  const ev = R.evaluarPromo(p, { costo: 153, seg: 'quieto' });
  const body = cuerpoParaAceptar(p, ev, 29);
  assert.strictEqual(body.promotion_type, 'PRICE_DISCOUNT');
  assert.strictEqual(body.deal_price, 655.5);
  assert.ok(body.start_date && body.finish_date);
  assert.ok(!('promotion_id' in body));
});

test('relámpago compartida (cofondeada): manda offer_id y unidades, sin precio', () => {
  const p = R.normalizarPromo({
    id: 'P-MLU18023294', type: 'SMART_LIGHTNING', status: 'candidate', name: 'Relámpagos compartidas',
    original_price: 990, price: 672.21, meli_percentage: 5.6, seller_percentage: 26.5,
    ref_id: 'CANDIDATE-MLU1038796032-77281344782', stock: { min: 5, max: 10 },
  }, 990);
  const ev = R.evaluarPromo(p, { costo: 180, seg: 'quieto' });
  assert.strictEqual(ev.veredicto, 'aceptar');
  assert.strictEqual(ev.vendedor_pct, 26.5);
  const body = cuerpoParaAceptar(p, ev, 18);
  assert.deepStrictEqual(body, {
    promotion_id: 'P-MLU18023294', promotion_type: 'SMART_LIGHTNING',
    offer_id: 'CANDIDATE-MLU1038796032-77281344782', stock: 10,
  });
});

test('oferta del día: manda las unidades; sin el mínimo de stock se rechaza antes de intentar', () => {
  const crudo = {
    id: 'DOD-MLU1000', type: 'DOD', ref_id: 'CANDIDATE-MLU1038821466-77105376144', status: 'candidate',
    price: 1251.3, original_price: 1290, min_discounted_price: 258, max_discounted_price: 1161,
    suggested_discounted_price: 1096.5, stock: { min: 15 },
  };
  const conStock = armarPublicacion({ costo: 405, segmento: 'algo', stock: 24 },
    { meli_id: 'MLU1038821466', precio: 1290 }, [crudo], null);
  const p = conStock.propuestas[0];
  assert.strictEqual(p.evaluacion.veredicto, 'aceptar');           // 15% sugerido, máximo 20%
  assert.strictEqual(cuerpoParaAceptar(p, p.evaluacion, 24).stock, 24);
  const poco = armarPublicacion({ costo: 405, segmento: 'algo', stock: 8 },
    { meli_id: 'MLU1038821466', precio: 1290 }, [crudo], null);
  assert.strictEqual(poco.propuestas[0].evaluacion.veredicto, 'rechazar');
  assert.match(poco.propuestas[0].evaluacion.motivo, /al menos 15 unidades/);
});

// ── Piso neto: después de comisión y envío gratis queda ≥ 30% ────────────────

test('guardamanos azul: la relámpago compartida de 23% deja −$6 → rechazar', () => {
  const ctx = { costo: 277, seg: 'quieto', comision: 0.189, envio: 285 };
  const lim = R.limites({ precioLista: 890, ...ctx });
  assert.strictEqual(lim.maximo, 0);                 // ni a precio lleno llega al 30% neto
  assert.strictEqual(lim.limita, 'neto');
  assert.strictEqual(lim.neto_hoy, 160);
  const p = R.normalizarPromo({ id: 'P', type: 'SMART_LIGHTNING', status: 'candidate', original_price: 890,
    price: 629.48, meli_percentage: 6.3, seller_percentage: 23 }, 890);
  const ev = R.evaluarPromo(p, ctx);
  assert.strictEqual(ev.veredicto, 'rechazar');
  assert.ok(ev.neto < 0 && ev.neto > -10);           // −$6
  assert.match(ev.motivo, /comisión y envío/);
});

test('pata de cabra: con envío gratis ya pierde a precio lleno', () => {
  const lim = R.limites({ precioLista: 274, costo: 79, seg: 'quieto', comision: 0.205, envio: 159 });
  assert.ok(lim.neto_hoy < 0);
  assert.strictEqual(lim.maximo, 0);
});

test('soporte celular: el piso neto deja hasta ~10%, menos que el 20% del segmento', () => {
  const ctx = { costo: 88, seg: 'algo', comision: 0.177, envio: 159 };
  const lim = R.limites({ precioLista: 490, ...ctx });
  // p ≥ (88 + 159) / (0,70 − 0,177) = $472 → máximo 3,6%
  assert.strictEqual(lim.piso_precio, Math.ceil((88 + 159) / (0.70 - 0.177)));
  assert.ok(lim.maximo < 0.05);
  assert.strictEqual(R.descuentoPropio({ precioLista: 490, ...ctx }), null);   // menos del 5% que pide MELI
});

test('HS-30006: margen alto, el piso neto deja el 30% del segmento', () => {
  const lim = R.limites({ precioLista: 690, costo: 153, seg: 'quieto', comision: 0.153, envio: 159 });
  // p ≥ (153 + 159) / 0,547 = $571 → máximo 17,3%
  assert.ok(lim.maximo > 0.17 && lim.maximo < 0.18);
  assert.strictEqual(lim.limita, 'neto');
});

// ── Precio creíble: por debajo de lo vendido en los últimos 30 días ─────────

test('portapatente: el 5% a $1.226 no es creíble (vendido a $1.188); entra a $1.175', () => {
  const p = R.normalizarPromo({ type: 'PRICE_DISCOUNT', status: 'candidate', original_price: 1290, price: 0,
    min_discounted_price: 490.2, max_discounted_price: 1225.5, suggested_discounted_price: 1225.5 }, 1290);
  const ctx = { costo: 405, seg: 'algo', comision: 0.151, envio: 125, precioReciente: 1176.85 };
  const ev = R.evaluarPromo(p, ctx);
  assert.strictEqual(ev.veredicto, 'aceptar');
  assert.strictEqual(ev.deal_price, 1175);
  assert.match(ev.motivo, /últimos 30 días/);
  assert.ok(ev.neto_pct >= 30);
  // El descuento propio también queda por debajo.
  assert.ok(R.descuentoPropio({ precioLista: 1290, ...ctx }).precio < 1176.85);
});

test('precio creíble imposible dentro de las reglas → rechazar con el motivo', () => {
  const p = R.normalizarPromo({ type: 'PRICE_DISCOUNT', status: 'candidate', original_price: 1190, price: 0,
    min_discounted_price: 238, max_discounted_price: 1130.5, suggested_discounted_price: 1130.5 }, 1190);
  // Fat bar rojo: máximo ~6% por el piso neto; si se vendió a $1.000 hace poco, no llega.
  const ev = R.evaluarPromo(p, { costo: 484, seg: 'quieto', comision: 0.146, envio: 135, precioReciente: 1000 });
  assert.strictEqual(ev.veredicto, 'rechazar');
  assert.match(ev.motivo, /no lo toma como descuento/);
});

test('promos de precio fijo (cofondeadas) no se tocan por el precio reciente', () => {
  const p = R.normalizarPromo({ id: 'P', type: 'SMART_LIGHTNING', status: 'candidate', original_price: 990,
    price: 672.21, meli_percentage: 5.6, seller_percentage: 26.5 }, 990);
  const ev = R.evaluarPromo(p, { costo: 180, seg: 'quieto', comision: 0.192, envio: 159, precioReciente: 600 });
  assert.strictEqual(ev.veredicto, 'aceptar');
  assert.strictEqual(ev.deal_price, null);
});
