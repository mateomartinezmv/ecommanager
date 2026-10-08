// La migración de movimientos se corre a mano en el SQL Editor de Supabase, así que entre
// el deploy y ese paso el CRM queda con las tablas sin crear. En ese estado tiene que seguir
// funcionando todo lo demás y la pantalla nueva tiene que explicar qué falta, en vez de
// romper o mostrar números en blanco.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, erroresReales, leerTarjetas } = require('./helpers');

let crm;
const valor = (tarjetas, etiqueta) => (tarjetas.find(t => t.etiqueta.startsWith(etiqueta)) || {}).valor;

before(async () => {
  crm = await abrirCRM({
    // Lo que responde Supabase cuando la tabla no existe.
    fallos: { '/movimientos': { status: 500, error: 'relation "public.movimientos" does not exist' } },
  });
});

after(async () => { if (crm) await crm.cerrar(); });

test('el resto del CRM carga igual', async () => {
  await crm.page.waitForSelector('#dash-stats .stat-card');
  assert.ok((await crm.page.$$('#dash-stats .stat-card')).length > 0);
  assert.strictEqual(await crm.page.evaluate(() => db.ventas.length), 1);
  assert.strictEqual(await crm.page.evaluate(() => db.movimientosMeta.cargada), false);
});

test('Reportes calcula la ganancia con los movimientos en cero', async () => {
  await crm.page.click(`.nav-item[onclick="goPage('reportes')"]`);
  await crm.page.waitForSelector('#reporte-stats .stat-card');
  const tarjetas = await leerTarjetas(crm.page, '#reporte-stats');
  assert.strictEqual(valor(tarjetas, 'Otros gastos'), '$0');
  assert.strictEqual(valor(tarjetas, 'Otros ingresos'), '$0');
  assert.ok(valor(tarjetas, 'Ganancia neta'), 'la ganancia neta se sigue calculando');
});

test('la pantalla de Finanzas dice qué archivo hay que correr', async () => {
  await crm.page.click(`.nav-item[onclick="goPage('finanzas')"]`);
  await crm.page.waitForSelector('#finanzas-aviso');
  const aviso = await crm.page.textContent('#finanzas-aviso');
  assert.match(aviso, /Falta crear las tablas en Supabase/);
  assert.match(aviso, /20261008000000_add_movimientos\.sql/);
  assert.ok(await crm.page.isVisible('#finanzas-empty'), 'la tabla queda vacía, no rota');
});

test('no hubo errores ni alertas', () => {
  assert.deepStrictEqual(crm.alertas, [], 'no molesta con alertas: ' + JSON.stringify(crm.alertas));
  // El 500 de /movimientos lo provoca este test a propósito.
  const reales = erroresReales(crm.errores, [/500 \(Internal Server Error\)/]);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});
