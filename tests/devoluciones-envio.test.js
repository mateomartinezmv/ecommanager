// ↩️ Devoluciones → 🚚 Envío de vuelta: lo que se paga para que el producto vuelva desde la
// dirección del cliente hasta el depósito.
//
// Lo que se protege: que el costo se pueda cargar al registrar la devolución y después (en
// pendientes y en recibidas), que viaje a la API, y que entre directo en Reportes como
// "Envíos de devoluciones" restando de la ganancia neta en el período de la devolución
// (también en el desglose con ads, en el gráfico diario y en el comparador). Y que sin la
// migración la devolución se registre igual y la pantalla avise que el costo no se guardó.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { HOY, haceDias, estadoDemo, abrirCRM, erroresReales, leerTarjetas } = require('./helpers');

let crm;
let gananciaAntes;
const aNumero = s => Number(String(s).replace(/[^\d-]/g, ''));
const valor = (tarjetas, etiqueta) => (tarjetas.find(t => t.etiqueta.startsWith(etiqueta)) || {}).valor;
// Los alert() se anotan del lado de Node, así que se espera a que aparezcan.
async function esperarAlertas(c, n) {
  for (let i = 0; i < 50 && c.alertas.length < n; i++) await new Promise(r => setTimeout(r, 50));
}

before(async () => {
  const estado = estadoDemo();
  estado.devoluciones = [
    { id: 'DEV-1', venta_id: 'V-1', sku: 'SKU1', producto: 'Slider', cantidad: 1, estado: 'recibida',
      notas: null, costo_envio: 0, created_at: HOY + 'T10:00:00Z', recibida_at: HOY + 'T12:00:00Z' },
    // Fuera de los últimos 30 días: sólo cuenta con "Todo el tiempo".
    { id: 'DEV-VIEJA', venta_id: null, sku: 'SKU2', producto: 'Espejo redondo', cantidad: 1, estado: 'recibida',
      notas: null, costo_envio: 500, created_at: haceDias(60) + 'T10:00:00Z', recibida_at: haceDias(58) + 'T10:00:00Z' },
  ];
  crm = await abrirCRM({ estado });
});

after(async () => { if (crm) await crm.cerrar(); });

async function irAReportes(page) {
  await page.click(`.nav-item[onclick="goPage('reportes')"]`);
  await page.waitForSelector('#reporte-stats .stat-card');
  return leerTarjetas(page, '#reporte-stats');
}

test('Reportes arranca con la tarjeta de envíos de devoluciones en cero', async () => {
  const tarjetas = await irAReportes(crm.page);
  assert.strictEqual(valor(tarjetas, 'Envíos de devoluciones'), '$0');
  gananciaAntes = aNumero(valor(tarjetas, 'Ganancia neta'));
});

test('al registrar una devolución se carga el costo del envío de vuelta', async () => {
  const { page, estado } = crm;
  await page.click(`.nav-item[onclick="goPage('ventas')"]`);
  await page.click(`button[onclick="openCrearDevolucion('V-1')"]`);
  await page.waitForSelector('#modal-devolucion.open');
  await page.fill('#dev-cantidad', '1');
  await page.fill('#dev-costo-envio', '350');
  await page.click('#modal-devolucion .btn-primary');
  await page.waitForSelector('#page-devoluciones.active');

  const nueva = estado.devoluciones.find(d => d.id.startsWith('DEV-') && d.id !== 'DEV-1' && d.id !== 'DEV-VIEJA');
  assert.ok(nueva, 'la devolución se registró');
  assert.strictEqual(nueva.costo_envio, 350);
  const fila = await page.textContent(`#devoluciones-tbody tr:has-text("${nueva.id}")`);
  assert.match(fila, /\$350/);
  assert.match(await page.textContent('#devoluciones-resumen-envio'), /\$350/);
});

test('el costo se puede cargar después, también en una devolución ya recibida', async () => {
  const { page, estado } = crm;
  await page.click('#tab-dev-recibida');
  await page.click(`button[onclick="openCostoEnvioDevolucion('DEV-1')"]`);
  await page.waitForSelector('#modal-dev-costo.open');
  await page.fill('#dev-costo-monto', '200');
  await page.click('#dev-costo-guardar');
  await page.waitForSelector('#modal-dev-costo.open', { state: 'hidden' });

  assert.strictEqual(estado.devoluciones.find(d => d.id === 'DEV-1').costo_envio, 200);
  assert.match(await page.textContent(`#devoluciones-tbody tr:has-text("DEV-1")`), /\$200/);
});

test('un monto inválido no se manda', async () => {
  const { page, estado } = crm;
  await page.click(`button[onclick="openCostoEnvioDevolucion('DEV-1')"]`);
  await page.waitForSelector('#modal-dev-costo.open');
  await page.fill('#dev-costo-monto', '-50');
  await page.click('#dev-costo-guardar');
  assert.match(crm.alertas.pop() || '', /mayor o igual a 0/);
  assert.strictEqual(estado.devoluciones.find(d => d.id === 'DEV-1').costo_envio, 200, 'no se pisó');
  await page.click('#modal-dev-costo .btn-ghost');
});

test('Reportes suma los envíos de devoluciones del período y los resta de la ganancia', async () => {
  const { page } = crm;
  const tarjetas = await irAReportes(page);
  assert.strictEqual(aNumero(valor(tarjetas, 'Envíos de devoluciones')), 550, '350 + 200, sin la de hace 60 días');
  assert.match(tarjetas.find(t => t.etiqueta.startsWith('Envíos de devoluciones')).etiqueta, /\(2\)/, 'cuántas devoluciones tuvieron costo');
  assert.strictEqual(aNumero(valor(tarjetas, 'Ganancia neta')), gananciaAntes - 550);

  await page.waitForSelector('.reporte-ganancia-con-ads');
  assert.match(await page.textContent('#reporte-ads'), /Envíos de devoluciones: \$550/);
});

test('con "Todo el tiempo" entra también la devolución vieja', async () => {
  const { page } = crm;
  await page.selectOption('#reporte-periodo', 'all');
  await page.waitForFunction(() => /1\.050/.test(document.getElementById('reporte-stats').textContent));
  const tarjetas = await leerTarjetas(page, '#reporte-stats');
  assert.strictEqual(aNumero(valor(tarjetas, 'Envíos de devoluciones')), 1050);
  await page.selectOption('#reporte-periodo', '30');
});

test('el gráfico diario y el comparador también lo cuentan', async () => {
  const r = await crm.page.evaluate(({ hoy, viejo }) => {
    const dias = serieDiaria(hoy, hoy, null);
    const m = metricasComparacion(hoy, hoy, viejo, viejo, 0, 0);
    return { enviosHoy: dias[0].envios, fila: m.find(x => x.nombre === 'Envíos de devoluciones') };
  }, { hoy: HOY, viejo: haceDias(60) });
  assert.strictEqual(r.enviosHoy, 550);
  assert.deepStrictEqual([r.fila.a, r.fila.b], [550, 500]);
});

test('no hubo errores ni alertas', () => {
  assert.deepStrictEqual(crm.alertas, [], 'alertas inesperadas: ' + JSON.stringify(crm.alertas));
  const reales = erroresReales(crm.errores);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});

test('sin la migración la devolución se registra igual y avisa que el costo no se guardó', async () => {
  const estado = estadoDemo();
  estado.sinCostoEnvioDevol = true;
  const otro = await abrirCRM({ estado });
  try {
    await otro.page.click(`.nav-item[onclick="goPage('ventas')"]`);
    await otro.page.click(`button[onclick="openCrearDevolucion('V-1')"]`);
    await otro.page.waitForSelector('#modal-devolucion.open');
    await otro.page.fill('#dev-costo-envio', '350');
    await otro.page.click('#modal-devolucion .btn-primary');
    await otro.page.waitForSelector('#page-devoluciones.active');
    await esperarAlertas(otro, 1);

    assert.strictEqual(estado.devoluciones.length, 1, 'la devolución quedó pendiente');
    assert.strictEqual(estado.devoluciones[0].costo_envio, undefined);
    assert.strictEqual(otro.alertas.length, 1);
    assert.match(otro.alertas[0], /20261104000000_add_costo_envio_devoluciones\.sql/);

    // Cargarlo después tampoco rompe: explica qué falta.
    await otro.page.click(`button[onclick="openCostoEnvioDevolucion('${estado.devoluciones[0].id}')"]`);
    await otro.page.fill('#dev-costo-monto', '100');
    await otro.page.click('#dev-costo-guardar');
    await esperarAlertas(otro, 2);
    assert.match(otro.alertas[1] || '', /Falta correr la migración/);
  } finally { await otro.cerrar(); }
});
