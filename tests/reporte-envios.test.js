// Reportes → Envíos: cuánto se gastó por transportista y cuántos envíos salieron de cada tipo.
//
// Lo que se protege: que el gasto sea costo + colecta (igual que el Resumen), que respete el
// período elegido, que los envíos se cuenten por tipo (MELI Envíos, Flex, Interior) y por
// origen de la venta (mostrador aparte), y que lo que MELI cobra por envío se muestre sin
// sumarse al gasto porque ya está dentro de la comisión.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { HOY, haceDias, estadoDemo, abrirCRM, erroresReales, leerTarjetas } = require('./helpers');

let crm;

before(async () => {
  const estado = estadoDemo();
  estado.ventas[0].costo_envio_meli = 180;
  const venta = (id, canal) => ({ id, canal, fecha: HOY, sku: 'SKU1', producto: 'Slider', cantidad: 1,
    precio_unit: 1000, comision: 0, total: 1000, estado: 'pagada', metodo_pago: 'efectivo', created_at: HOY });
  estado.ventas.push(venta('V-M1', 'mostrador'), venta('V-M2', 'mostrador'), venta('V-F1', 'meli'), venta('V-S1', 'shopify'));
  const envio = (id, ventaId, transportista, costo, extra = {}) => ({ id, venta_id: ventaId, orden: ventaId,
    comprador: 'X', producto: 'Slider', transportista, estado: 'entregado', costo, created_at: HOY, ...extra });
  estado.envios = [
    envio('E-ME', 'V-1', 'mercado_envios', 0),
    envio('E-F1', 'V-F1', 'enviosuy', 150, { colecta: true }),           // Flex de MELI: 225
    envio('E-M1', 'V-M1', 'enviosuy', 150, { pagado: true }),            // Flex de mostrador: 150
    envio('E-M2', 'V-M2', 'ues', 300),                                   // Interior de mostrador: 300
    envio('E-S1', 'V-S1', 'gestionpost', 120),                           // Flex de Shopify: 120
    envio('E-VIEJO', 'V-M1', 'dac', 500, { created_at: haceDias(60) }),  // fuera de los 30 días
  ];
  crm = await abrirCRM({ estado });
  await crm.page.click(`.nav-item[onclick="goPage('reportes')"]`);
  await crm.page.click(`#page-reportes .tab[onclick="switchReportesTab('envios')"]`);
});

after(async () => { await crm.cerrar(); });

const aNumero = s => Number(String(s).replace(/[^\d-]/g, ''));
const valor = (tarjetas, etiqueta) => tarjetas.find(t => t.etiqueta.startsWith(etiqueta))?.valor;

test('la pestaña Envíos muestra totales del período', async () => {
  assert.ok(await crm.page.isVisible('#panel-envios-reporte'));
  assert.ok(!(await crm.page.isVisible('#panel-resumen')));
  const tarjetas = await leerTarjetas(crm.page, '#envrep-stats');
  assert.strictEqual(valor(tarjetas, 'Envíos en el período'), '5');
  assert.strictEqual(aNumero(valor(tarjetas, 'Gasto total')), 225 + 150 + 300 + 120);
  assert.strictEqual(aNumero(valor(tarjetas, 'Pendiente de pagar')), 225 + 300 + 120);
});

test('cuenta los envíos por tipo y los de mostrador', async () => {
  const tarjetas = await leerTarjetas(crm.page, '#envrep-tipos');
  assert.strictEqual(valor(tarjetas, '📦 MELI Envíos'), '1');
  assert.strictEqual(valor(tarjetas, '⚡ Flex'), '3');
  assert.strictEqual(valor(tarjetas, '🛣️ Interior'), '1');
  assert.strictEqual(valor(tarjetas, '🏪 De mostrador'), '2');
});

test('desglosa el gasto por transportista', async () => {
  const r = await crm.page.evaluate(() => {
    const { desde, hasta } = getReporteFiltro();
    const envios = db.envios.filter(e => { const d = (e.creado || '').slice(0, 10); return d >= desde && d <= hasta; });
    return calcularReporteEnvios(envios, db.ventas);
  });
  const t = Object.fromEntries(r.transportistas.map(x => [x.transportista, x]));
  assert.deepStrictEqual(r.transportistas.map(x => x.transportista), ['enviosuy', 'ues', 'gestionpost', 'mercado_envios']);
  assert.strictEqual(t.enviosuy.envios, 2);
  assert.strictEqual(t.enviosuy.gasto, 375);
  assert.strictEqual(t.enviosuy.pagado, 150);
  assert.strictEqual(t.enviosuy.colectas, 1);
  assert.strictEqual(t.mercado_envios.gasto, 0, 'lo que cobra MELI no suma al gasto');
  assert.strictEqual(t.mercado_envios.costoMeli, 180);
  assert.strictEqual(r.porTipo.flex.porCanal.mostrador, 1);
  assert.strictEqual(r.porTipo.interior.porCanal.mostrador, 1);
  assert.strictEqual(r.porTipo.flex.porCanal.meli, 1);

  const texto = await crm.page.textContent('#envrep-transportistas');
  assert.match(texto, /cobrado por MELI/);
  assert.ok(!texto.includes('DAC'), 'el envío de hace 60 días queda afuera');
});

test('cambiar el período recalcula la pestaña', async () => {
  await crm.page.selectOption('#reporte-periodo', 'all');
  const tarjetas = await leerTarjetas(crm.page, '#envrep-stats');
  assert.strictEqual(valor(tarjetas, 'Envíos en el período'), '6');
  assert.ok((await crm.page.textContent('#envrep-transportistas')).includes('DAC'));
  assert.deepStrictEqual(erroresReales(crm.errores), []);
});
