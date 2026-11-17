// El formulario de envío del CRM con GestionPost por defecto: que proponga GestionPost y
// complete el costo de su tarifa por zona (El Dorado a $290), y que al cambiar a EnviosUy
// tome la de EnviosUy.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { estadoDemo, abrirCRM, erroresReales } = require('./helpers');

let crm;

before(async () => {
  crm = await abrirCRM({ estado: estadoDemo() });
});

after(async () => { await crm.cerrar(); });

const formulario = () => crm.page.evaluate(() => ({
  transportista: document.getElementById('env-transportista').value,
  costo: document.getElementById('env-costo').value,
}));

async function elegirZona(zona) {
  await crm.page.selectOption('#env-zona', String(zona));
}

test('un envío nuevo propone GestionPost con el costo de su zona', async () => {
  await crm.page.evaluate(() => openEnvioManual(null));
  assert.strictEqual((await formulario()).transportista, 'gestionpost');

  await elegirZona(6);
  assert.deepStrictEqual(await formulario(), { transportista: 'gestionpost', costo: '169' });
  await elegirZona(9);
  assert.strictEqual((await formulario()).costo, '290');
  await elegirZona(11);
  assert.strictEqual((await formulario()).costo, '290');
  await elegirZona(3);
  assert.strictEqual((await formulario()).costo, '200');
});

test('El Dorado sale $290 aunque sea zona 10, y EnviosUy usa su propia tarifa', async () => {
  await crm.page.evaluate(() => openEnvioManual(null));
  await crm.page.fill('#env-direccion', 'Calle 18 de Mayo, El Dorado');
  await elegirZona(10);
  assert.strictEqual((await formulario()).costo, '290');

  await crm.page.fill('#env-direccion', 'Giannattasio, Solymar');
  await elegirZona(10);
  assert.strictEqual((await formulario()).costo, '200');

  await crm.page.selectOption('#env-transportista', 'enviosuy');
  await elegirZona(6);
  assert.strictEqual((await formulario()).costo, '160');
});

test('sin errores de consola', () => {
  assert.deepStrictEqual(erroresReales(crm.errores), []);
});
