// La sección 💰 Productos por margen de la pestaña de Ads: el catálogo partido por
// margen (precio − costo) para armar una campaña por segmento.
//
// Lo que se protege: que el margen sea precio − costo, que cada producto caiga en el
// segmento que dicen los cortes, que los cortes se puedan mover, y que lo que no se puede
// clasificar (sin costo, costo mayor al precio) se muestre aparte y no se mezcle.

const { test } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, estadoDemo, erroresReales } = require('./helpers');

const HOY = new Date().toISOString().slice(0, 10);
const prod = (sku, nombre, precio, costo, stock, extra = {}) => ({
  sku, nombre, tipo: 'nuevo', grupo: 'G', subgrupo: '', stock_dep: stock, stock_meli: stock,
  stock_shopify: 0, costo, precio, alerta_min: 0, discontinuado: false, created_at: HOY, ...extra,
});

function estado() {
  const e = estadoDemo();
  e.productos = [
    prod('ALTO', 'Baúl 45L', 1000, 400, 5),            // $600 · 60%
    prod('MEDIO', 'Espejo', 1000, 700, 3),             // $300 · 30%
    prod('BAJO', 'Slider', 1000, 900, 8),              // $100 · 10%
    prod('PIERDE', 'Puños', 500, 600, 2),              // −$100
    prod('SINCOSTO', 'Gato', 800, 0, 4),               // sin costo
    prod('SINSTOCK', 'Manillar', 2000, 500, 0),        // 75%, pero sin stock
    prod('BAJA', 'Viejo', 2000, 100, 9, { discontinuado: true }),
  ];
  // Ventas MELI de los últimos 30 días: el peso de cada segmento es margen $ × unidades.
  //   alto  600 × 2 = 1200 · medio 300 × 4 = 1200 · bajo 100 × 1 (sin ventas cuenta 1) = 100
  const venta = (id, sku, cantidad, extra = {}) => ({ id, canal: 'meli', fecha: HOY, sku, producto: sku,
    cantidad, precio_unit: 1000, comision: 0, total: 1000 * cantidad, estado: 'completada', created_at: HOY, ...extra });
  e.ventas = [
    venta('V-1', 'ALTO', 2), venta('V-2', 'MEDIO', 4),
    venta('V-3', 'BAJO', 5, { estado: 'cancelada' }),           // cancelada: no cuenta
    venta('V-4', 'BAJO', 5, { canal: 'mostrador' }),            // mostrador: no es MELI
  ];
  // Período de 30 días: el gasto actual/mes es el mismo número que el del período.
  const hace29 = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const anuncio = (id, sku, inversion, facturacion, ganancia, roas_breakeven) => ({
    ad_group_id: id, campaign_id: '1', titulo: sku, status: 'ACTIVE', item_ids: ['MLU' + id], variantes: 1,
    impresiones: 10, clics: 1, inversion, facturacion, unidades: 1, ctr: 10, cpc: inversion, cvr: 100,
    roas: facturacion / inversion, acos: 0, sku, costo: 1, margen: 40, roas_breakeven, ganancia, estado: 'ganando' });
  e.adsCampanas = [{ id: '1', nombre: 'C1', inversion: 210, roas: 3 }];
  e.adsAnuncios = {
    ok: true, periodo: { desde: hace29, hasta: HOY }, campaign_id: '1',
    totales: { anuncios: 2, impresiones: 20, clics: 2, inversion: 210, facturacion: 330, unidades: 2,
      roas: 1.57, ganancia: -30, anuncios_con_costo: 2, anuncios_sin_vincular: 0, anuncios_sku_sin_vincular: 0 },
    anuncios: [
      anuncio('1', 'ALTO', 10, 30, 20, 2),       // gasta poco y gana con colchón (3x contra 2x)
      anuncio('2', 'MEDIO', 200, 300, -50, 2),   // pierde plata
    ],
  };
  return e;
}

async function irAMargen() {
  const crm = await abrirCRM({ estado: estado() });
  await crm.page.click('.nav-item:has-text("Ads MELI")');
  await crm.page.waitForSelector('#ads-margen-lista table', { timeout: 15000 });
  return crm;
}

const skusDe = (page, seg) => page.$$eval(
  `[data-segmento-lista="${seg}"] tbody td:first-child`,
  tds => tds.map(td => td.textContent.split('·').pop().trim()));

test('cada producto cae en su segmento por margen % (precio − costo)', async () => {
  const crm = await irAMargen();
  try {
    assert.deepStrictEqual(await skusDe(crm.page, 'alto'), ['ALTO']);
    assert.deepStrictEqual(await skusDe(crm.page, 'medio'), ['MEDIO']);
    assert.deepStrictEqual(await skusDe(crm.page, 'bajo'), ['BAJO']);
    assert.deepStrictEqual(await skusDe(crm.page, 'sin_margen'), ['PIERDE']);
    assert.deepStrictEqual(await skusDe(crm.page, 'sin_datos'), ['SINCOSTO']);

    const fila = (await crm.page.textContent('[data-segmento-lista="alto"] tbody tr')).replace(/\s+/g, ' ');
    assert.match(fila, /\$600/, 'margen $ = 1000 − 400: ' + fila);
    assert.match(fila, /60\.0%/);
    assert.match(fila, /📣/, 'el que tiene anuncio activo se marca');

    const lista = await crm.page.textContent('#ads-margen-lista');
    assert.ok(!lista.includes('BAJA'), 'los descatalogados no se segmentan');
    assert.ok(!lista.includes('SINSTOCK'), 'sin stock queda afuera mientras el filtro esté prendido');
    assert.deepStrictEqual(erroresReales(crm.errores), []);
  } finally { await crm.cerrar(); }
});

test('los cortes se pueden mover y el filtro de stock se puede apagar', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.fill('#ads-margen-alto', '25');
    await crm.page.dispatchEvent('#ads-margen-alto', 'change');
    assert.deepStrictEqual(await skusDe(crm.page, 'alto'), ['ALTO', 'MEDIO']);

    await crm.page.uncheck('#ads-margen-stock');
    assert.deepStrictEqual(await skusDe(crm.page, 'alto'), ['SINSTOCK', 'ALTO', 'MEDIO']);
  } finally { await crm.cerrar(); }
});

test('en $ por unidad segmenta por el monto del margen', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.selectOption('#ads-margen-modo', 'monto');
    await crm.page.fill('#ads-margen-alto', '500');
    await crm.page.fill('#ads-margen-medio', '200');
    await crm.page.dispatchEvent('#ads-margen-medio', 'change');
    assert.deepStrictEqual(await skusDe(crm.page, 'alto'), ['ALTO']);
    assert.deepStrictEqual(await skusDe(crm.page, 'medio'), ['MEDIO']);
    assert.deepStrictEqual(await skusDe(crm.page, 'bajo'), ['BAJO']);
    const resumen = (await crm.page.textContent('#ads-margen-resumen')).replace(/\s+/g, ' ');
    assert.match(resumen, /\$500 o más/);
  } finally { await crm.cerrar(); }
});

const filaReparto = async (page, seg) =>
  (await page.textContent(`#ads-presupuesto-tabla tr[data-segmento="${seg}"]`)).replace(/\s+/g, ' ');
const recoDe = (page, seg) =>
  page.getAttribute(`#ads-presupuesto-tabla tr[data-segmento="${seg}"]`, 'data-reco');

test('el presupuesto se reparte por margen × ventas y dice qué subir y qué bajar', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.fill('#ads-presupuesto', '1000');
    await crm.page.waitForSelector('#ads-presupuesto-tabla');
    // 1000 sobre pesos 1200 / 1200 / 100 → 480 / 480 / 40.
    assert.match(await filaReparto(crm.page, 'alto'), /\$480/);
    assert.match(await filaReparto(crm.page, 'medio'), /\$480/);
    assert.match(await filaReparto(crm.page, 'bajo'), /\$40/);
    assert.match(await crm.page.textContent('#ads-presupuesto-diario'), /\$33 por día/);

    assert.strictEqual(await recoDe(crm.page, 'alto'), 'subir', 'gasta 10 de 480 sugeridos y gana con colchón');
    assert.strictEqual(await recoDe(crm.page, 'medio'), 'bajar', 'el ads del segmento pierde plata');
    assert.match(await filaReparto(crm.page, 'medio'), /pierde \$50/);
    assert.strictEqual(await recoDe(crm.page, 'bajo'), 'arrancar', 'sin gasto todavía');
    assert.strictEqual(await crm.page.$('#ads-presupuesto-sobrante'), null);
    assert.deepStrictEqual(erroresReales(crm.errores), []);
  } finally { await crm.cerrar(); }
});

test('más presupuesto del que el margen paga: cada segmento queda en su tope y sobra', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.fill('#ads-presupuesto', '3000');
    await crm.page.waitForSelector('#ads-presupuesto-sobrante');
    assert.match(await filaReparto(crm.page, 'alto'), /\$1\.200.*tope/);
    assert.match(await filaReparto(crm.page, 'bajo'), /\$100.*tope/);
    assert.match(await crm.page.textContent('#ads-presupuesto-sobrante'), /Bajar el presupuesto total: sobran \$500/);
  } finally { await crm.cerrar(); }
});
