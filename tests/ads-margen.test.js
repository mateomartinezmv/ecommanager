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
  const anuncio = (id, sku, inversion, facturacion, ganancia, roas_breakeven, extra = {}) => ({
    ad_group_id: id, campaign_id: '1', titulo: sku, status: 'ACTIVE', item_ids: ['MLU' + id], variantes: 1,
    impresiones: 10, clics: 1, inversion, facturacion, unidades: 1, ctr: 10, cpc: inversion, cvr: 100,
    roas: inversion ? facturacion / inversion : 0, acos: 0, sku, costo: 1, margen: 40, roas_breakeven, ganancia, estado: 'ganando', ...extra });
  // C1 tiene ROAS objetivo 1,67x (ACOS 60%) y su equilibrio es 2x: deja perder plata.
  // C2 no tiene anuncios cargados: no se puede calcular su equilibrio.
  e.adsCampanas = [
    { id: '1', nombre: 'C1', status: 'active', presupuesto: 50, estrategia: 'profitability', acos_objetivo: 60, inversion: 210, roas: 3 },
    { id: '2', nombre: 'C2', status: 'paused', presupuesto: 30, estrategia: 'increase', acos_objetivo: 25, inversion: 0, roas: 0 },
  ];
  e.adsAnuncios = {
    ok: true, periodo: { desde: hace29, hasta: HOY }, campaign_id: '1',
    totales: { anuncios: 2, impresiones: 20, clics: 2, inversion: 210, facturacion: 330, unidades: 2,
      roas: 1.57, ganancia: -30, anuncios_con_costo: 2, anuncios_sin_vincular: 0, anuncios_sku_sin_vincular: 0 },
    anuncios: [
      anuncio('1', 'ALTO', 10, 30, 20, 2, { unidades_organicas: 3, facturacion_organica: 3000 }),  // gasta poco y gana con colchón
      anuncio('2', 'MEDIO', 200, 300, -50, 2),   // pierde plata
      // Otro de margen alto en C1 (sin gasto): con ALTO hace que C1 sea "la de margen alto",
      // y entonces MEDIO quedó en la campaña equivocada.
      anuncio('3', 'SINSTOCK', 0, 0, 0, 2),
    ],
  };
  // Comisión 10% y envío $100 para todos: margen real = bruto − 10% del precio − 100.
  const eco = { comision_pct: 10, envio_unitario: 100, fuente: 'sku', ventas_muestra: 10 };
  e.adsEconomia = { ok: true, global: { comision_pct: 10, envio_unitario: 100 },
    por_sku: Object.fromEntries(e.productos.map(p => [p.sku, eco])) };
  e.adsEvolucion = { ok: true, semanas: 12, inversion_sin_sku: 0, filas: [
    { semana: '2026-10-05', sku: 'ALTO', inversion: 100, facturacion: 500, unidades: 1 },
    { semana: '2026-10-05', sku: 'MEDIO', inversion: 300, facturacion: 300, unidades: 1 },
    { semana: '2026-10-12', sku: 'ALTO', inversion: 50, facturacion: 1000, unidades: 2 },
  ] };
  e.adsCambios = { ok: true, cambios: [{
    id: 1, fecha: '2026-09-20', nivel: 'campana', campaign_id: '1', campaign_name: 'C1', campo: 'presupuesto',
    valor_anterior: '50', valor_nuevo: '80', origen: 'crm', nota: null,
    antes: { dias: 14, ganancia_dia: 10, roas: 2, inversion_dia: 50 },
    despues: { dias: 14, ganancia_dia: 40, roas: 3, inversion_dia: 80 },
    veredicto: 'mejoro',
  }] };
  return e;
}

async function irAMargen(est = estado()) {
  const crm = await abrirCRM({ estado: est });
  crm.estado = est;
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

// ── Campañas, margen real, acciones, evolución y cambios ─────────────────────────────

/** Espera a que el mock de la API haya recibido lo que la pantalla mandó. */
async function esperar(cond, ms = 5000) {
  const fin = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fin) throw new Error('timeout esperando la acción');
    await new Promise(r => setTimeout(r, 50));
  }
}

/** Espera a que llegue la economía por SKU (la columna de margen real deja de estar vacía). */
const esperarMargenReal = page => page.waitForFunction(() =>
  [...document.querySelectorAll('#ads-margen-lista td.margen-real')].some(td => td.textContent.trim() !== '—'));

test('la campaña con ROAS objetivo por debajo del equilibrio se marca y dice a cuánto subirlo', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.waitForSelector('#ads-campanas-tabla tr[data-campana="1"][data-diag="pierde"]');
    const fila = (await crm.page.textContent('#ads-campanas-tabla tr[data-campana="1"]')).replace(/\s+/g, ' ');
    assert.match(fila, /1\.67x/, 'ROAS objetivo = 100 / ACOS 60%');
    assert.match(fila, /Subilo a 2\.5x/, 'equilibrio 2x × 1,25 de colchón');
    assert.match(fila, /\$50/, 'presupuesto diario');
    assert.match(fila, /Rentabilidad/);
    assert.strictEqual(await crm.page.getAttribute('#ads-campanas-tabla tr[data-campana="2"]', 'data-diag'), 'sin_dato');
  } finally { await crm.cerrar(); }
});

test('el margen real descuenta comisión y envío, y se puede segmentar con él', async () => {
  const crm = await irAMargen();
  try {
    await esperarMargenReal(crm.page);
    const alto = (await crm.page.textContent('[data-segmento-lista="alto"] tbody tr')).replace(/\s+/g, ' ');
    assert.match(alto, /\$400 · 40\.0%/, '1000 − 400 − 100 de comisión − 100 de envío');
    assert.match(alto, /2\.50x/, 'ROAS de equilibrio = 1000 / 400');

    await crm.page.selectOption('#ads-margen-base', 'real');
    // Con el real: MEDIO deja 100 (10%) y pasa a bajo; BAJO deja −100 y queda sin margen.
    assert.deepStrictEqual(await skusDe(crm.page, 'alto'), ['ALTO']);
    assert.deepStrictEqual(await skusDe(crm.page, 'bajo'), ['MEDIO']);
    assert.deepStrictEqual(await skusDe(crm.page, 'sin_margen'), ['BAJO', 'PIERDE']);
  } finally { await crm.cerrar(); }
});

test('cada segmento trae su ROAS objetivo para cargar en MELI', async () => {
  const crm = await irAMargen();
  try {
    await esperarMargenReal(crm.page);
    await crm.page.fill('#ads-presupuesto', '1000');
    await crm.page.waitForSelector('#ads-presupuesto-tabla');
    // ALTO: equilibrio 2,5x con margen real × 1,25 = 3,125 → 3,2x redondeado para arriba.
    assert.strictEqual((await crm.page.textContent('#ads-presupuesto-tabla tr[data-segmento="alto"] .roas-objetivo')).trim(), '3.2x');
    assert.match(await crm.page.textContent('#ads-margen-resumen [data-segmento="alto"]'), /ROAS objetivo 3\.2x/);
  } finally { await crm.cerrar(); }
});

test('el producto que corre en la campaña de otro segmento se avisa', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.waitForSelector('#ads-equivocados-lista li[data-sku="MEDIO"]');
    const txt = (await crm.page.textContent('#ads-equivocados-lista')).replace(/\s+/g, ' ');
    assert.match(txt, /Espejo .* es de 🟡 margen medio y está en C1 \(campaña de 🟢 margen alto\)/);
    assert.ok(!txt.includes('Baúl'), 'ALTO está en la campaña de su segmento');
  } finally { await crm.cerrar(); }
});

test('aplicar el reparto manda a MELI el presupuesto diario y el ROAS objetivo del segmento', async () => {
  const crm = await irAMargen();
  try {
    await esperarMargenReal(crm.page);
    await crm.page.fill('#ads-presupuesto', '1000');
    await crm.page.click('#ads-presupuesto-tabla [data-aplicar="alto"]');
    await esperar(() => crm.estado.adsAcciones?.length);
    assert.deepStrictEqual(crm.estado.adsAcciones, [{
      nivel: 'campana', campaign_id: '1', campaign_name: 'C1',
      cambios: { presupuesto: 16, roas_objetivo: 3.2 },          // 480 al mes / 30
      anterior: { presupuesto: 50, roas_objetivo: 1.67 },
    }]);
  } finally { await crm.cerrar(); }
});

test('un anuncio se puede pausar desde la tabla', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.waitForSelector('#ads-tabla [data-accion-anuncio="2"]');
    await crm.page.click('#ads-tabla [data-accion-anuncio="2"]');
    await esperar(() => crm.estado.adsAcciones?.length);
    const a = (crm.estado.adsAcciones || [])[0];
    assert.ok(a, 'no se mandó la acción');
    assert.strictEqual(a.nivel, 'anuncio');
    assert.strictEqual(a.ad_group_id, '2');
    assert.deepStrictEqual(a.cambios, { estado: 'paused' });
  } finally { await crm.cerrar(); }
});

test('las ventas orgánicas y el TACOS se muestran', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.waitForSelector('#ads-card-organica');
    const card = (await crm.page.textContent('#ads-card-organica')).replace(/\s+/g, ' ');
    assert.match(card, /3/);
    // 210 de ads sobre 330 de facturación por ads + 3000 orgánica = 6,3%.
    assert.match(card, /TACOS 6\.3%/);
  } finally { await crm.cerrar(); }
});

test('la evolución suma por segmento con la ganancia después de ads', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.waitForSelector('#ads-evolucion-tabla');
    await esperarMargenReal(crm.page);
    // ALTO deja 400 por venta (real): 3 × 400 − 150 = 1050. MEDIO deja 100: 100 − 300 = −200.
    await crm.page.waitForFunction(() => /1\.050/.test(document.querySelector('#ads-evolucion-tabla tr[data-segmento="alto"]')?.textContent || ''));
    const medio = (await crm.page.textContent('#ads-evolucion-tabla tr[data-segmento="medio"]')).replace(/\s+/g, ' ');
    assert.match(medio, /-200/);
    assert.strictEqual(await crm.page.$$eval('#ads-evolucion svg .evol-linea', l => l.length), 2);
  } finally { await crm.cerrar(); }
});

test('los cambios registrados muestran el antes, el después y si sirvió', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.waitForSelector('#ads-cambios-tabla tr[data-veredicto="mejoro"]');
    const fila = (await crm.page.textContent('#ads-cambios-tabla tbody tr')).replace(/\s+/g, ' ');
    assert.match(fila, /Presupuesto\/día: \$50 → \$80/);
    assert.match(fila, /Mejoró la ganancia/);
    assert.deepStrictEqual(erroresReales(crm.errores), []);
  } finally { await crm.cerrar(); }
});

test('un cambio hecho directo en MELI se puede registrar a mano', async () => {
  const crm = await irAMargen();
  try {
    await crm.page.waitForSelector('#ads-campanas-tabla tr[data-campana="1"]');
    await crm.page.click('button:has-text("Registrar cambio hecho en MELI")');
    await crm.page.selectOption('#ads-cambio-campo', 'roas_objetivo');
    await crm.page.fill('#ads-cambio-anterior', '2');
    await crm.page.fill('#ads-cambio-nuevo', '3');
    await crm.page.click('#ads-cambio-form button:has-text("Guardar")');
    await crm.page.waitForFunction(() => document.getElementById('ads-cambio-form').style.display === 'none');
    const c = crm.estado.adsCambiosManuales[0];
    assert.strictEqual(c.campaign_id, '1');
    assert.strictEqual(c.campo, 'roas_objetivo');
    assert.strictEqual(c.valor_nuevo, '3');
  } finally { await crm.cerrar(); }
});
