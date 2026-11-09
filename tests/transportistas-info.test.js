// Transportistas → Información: desglose de gastos del período y transportista elegidos.
//
// Lo que se protege: que separe gasto en envíos (costo) de gasto en retiros (colecta $75),
// que respete el transportista y las fechas elegidas, que cuente por zona (más y menos
// enviada) y que los promedios por día usen todos los días del período, no sólo los que
// tuvieron envíos.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { estadoDemo, abrirCRM, erroresReales, leerTarjetas } = require('./helpers');

let crm;

before(async () => {
  const estado = estadoDemo();
  const envio = (id, transportista, fecha, costo, zona, extra = {}) => ({ id, venta_id: 'V-1', orden: id,
    comprador: 'X', producto: 'Slider', transportista, estado: 'entregado', costo, zona,
    fecha_despacho: fecha, created_at: fecha, ...extra });
  estado.envios = [
    envio('G1', 'gestionpost', '2026-10-01', 244, 7, { colecta: true }),
    envio('G2', 'gestionpost', '2026-10-01', 244, 7),
    envio('G3', 'gestionpost', '2026-10-01', 180, 3, { pagado: true }),
    envio('G4', 'gestionpost', '2026-10-03', 244, 7),
    envio('G5', 'gestionpost', '2026-10-05', 300, 9, { colecta: true }),
    envio('G-NOV', 'gestionpost', '2026-11-02', 244, 7),          // fuera del período
    envio('U1', 'ues', '2026-10-02', 500, null),                   // otro transportista
  ];
  crm = await abrirCRM({ estado });
  await crm.page.click(`.nav-item[onclick="goPage('transportistas')"]`);
  await crm.page.selectOption('#desglose-filtro', 'gestionpost');
  await crm.page.fill('#desglose-desde', '2026-10-01');
  await crm.page.fill('#desglose-hasta', '2026-10-05');
  await crm.page.click('#btn-transp-info');
});

after(async () => { await crm.cerrar(); });

const aNumero = s => Number(String(s).replace(/[^\d-]/g, ''));
const valor = (tarjetas, etiqueta) => tarjetas.find(t => t.etiqueta.startsWith(etiqueta))?.valor;

test('el botón Información cambia de vista y toma los filtros del desglose', async () => {
  assert.ok(await crm.page.isVisible('#transp-vista-info'));
  assert.ok(!(await crm.page.isVisible('#transp-vista-pagos')));
  assert.strictEqual(await crm.page.inputValue('#tinfo-transportista'), 'gestionpost');
  assert.strictEqual(await crm.page.inputValue('#tinfo-desde'), '2026-10-01');
  assert.strictEqual(await crm.page.inputValue('#tinfo-hasta'), '2026-10-05');
});

test('separa gasto en envíos y en retiros', async () => {
  const t = await leerTarjetas(crm.page, '#tinfo-gastos');
  assert.strictEqual(aNumero(valor(t, 'Gasto en envíos')), 244 * 3 + 180 + 300);
  assert.strictEqual(aNumero(valor(t, 'Gasto en retiros')), 150);
  assert.strictEqual(aNumero(valor(t, 'Gasto total')), 244 * 3 + 180 + 300 + 150);
});

test('cuenta por zona y marca la más y la menos enviada', async () => {
  const t = await leerTarjetas(crm.page, '#tinfo-zonas-resumen');
  assert.strictEqual(valor(t, 'Zona a la que más'), 'Zona 7');
  // Zona 3 y 9 tienen 1 envío cada una: gana la de menor gasto.
  assert.strictEqual(valor(t, 'Zona a la que menos'), 'Zona 3');
  const filas = await crm.page.$$eval('#tinfo-zonas tbody tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent.trim())));
  assert.deepStrictEqual(filas.map(f => [f[0], f[1]]), [['Zona 7', '3'], ['Zona 9', '1'], ['Zona 3', '1']]);
});

test('promedia por día sobre todo el período y encuentra el día máximo y mínimo', async () => {
  const r = await crm.page.evaluate(() => {
    const { envios, desde, hasta } = enviosParaInfoTransportistas();
    return calcularInfoTransportista(envios, { desde, hasta, hoy: '2026-12-31' });
  });
  assert.strictEqual(r.diasPeriodo, 5);
  assert.strictEqual(r.diasConEnvios, 3);
  assert.strictEqual(r.promedioDia, 1);
  assert.strictEqual(r.diaMax.fecha, '2026-10-01');
  assert.strictEqual(r.diaMax.envios, 3);
  assert.strictEqual(r.diaMin.fecha, '2026-10-03');
});

test('no promedia sobre días que todavía no llegaron', async () => {
  const r = await crm.page.evaluate(() => calcularInfoTransportista(
    [{ costo: 100, fecha: '2026-11-02' }], { desde: '2026-11-01', hasta: '2026-11-30', hoy: '2026-11-09' }));
  assert.strictEqual(r.fin, '2026-11-09');
  assert.strictEqual(r.diasPeriodo, 9);
});

test('con "Todos" suma los demás transportistas y muestra la tabla por transportista', async () => {
  await crm.page.selectOption('#tinfo-transportista', '');
  const t = await leerTarjetas(crm.page, '#tinfo-gastos');
  assert.strictEqual(aNumero(valor(t, 'Gasto en envíos')), 244 * 3 + 180 + 300 + 500);
  const texto = await crm.page.textContent('#tinfo-transportistas');
  assert.match(texto, /GestionPost/);
  assert.match(texto, /UES/);
  const zonas = await crm.page.textContent('#tinfo-zonas');
  assert.match(zonas, /Sin zona/);
});

test('volver a Pagos muestra el desglose y no hubo errores', async () => {
  await crm.page.click('#btn-transp-info');
  assert.ok(await crm.page.isVisible('#transp-vista-pagos'));
  assert.ok(!(await crm.page.isVisible('#transp-vista-info')));
  assert.deepStrictEqual(erroresReales(crm.errores), []);
});
