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
  e.adsCampanas = [{ id: '1', nombre: 'C1', inversion: 100, roas: 3 }];
  e.adsAnuncios = {
    ok: true, periodo: { desde: HOY, hasta: HOY }, campaign_id: '1',
    totales: { anuncios: 1, impresiones: 10, clics: 1, inversion: 100, facturacion: 300, unidades: 1,
      roas: 3, ganancia: 0, anuncios_con_costo: 1, anuncios_sin_vincular: 0, anuncios_sku_sin_vincular: 0 },
    anuncios: [{ ad_group_id: '1', campaign_id: '1', titulo: 'Baúl 45L', status: 'ACTIVE', item_ids: ['MLU1'],
      variantes: 1, impresiones: 10, clics: 1, inversion: 100, facturacion: 300, unidades: 1, ctr: 10, cpc: 100,
      cvr: 100, roas: 3, acos: 33, sku: 'ALTO', costo: 400, margen: 40, roas_breakeven: 2.5, estado: 'ganando' }],
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
