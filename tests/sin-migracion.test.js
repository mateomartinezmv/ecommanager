// Las migraciones se corren a mano en el SQL Editor de Supabase, así que entre el deploy y
// ese paso el CRM queda con las tablas o las columnas sin crear. En ese estado tiene que
// seguir funcionando todo lo demás y la pantalla nueva tiene que explicar qué falta, en vez
// de romper o mostrar números en blanco.
//
// Cubre los dos casos: la tabla de movimientos que no existe (Finanzas) y las columnas del
// motivo de descatalogado que todavía no están (Stock).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, erroresReales, leerTarjetas, estadoDemo } = require('./helpers');

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

// Sin las columnas del motivo, la API guarda el descatalogado igual (la columna
// `discontinuado` existe desde antes) y avisa que el motivo no entró. Lo importante es que
// descatalogar siga funcionando —el producto tiene que salir de reposición— y que la pantalla
// no muestre un motivo que en realidad no se guardó.
test('descatalogar funciona sin las columnas del motivo, y la pantalla lo avisa', async () => {
  const estado = estadoDemo();
  estado.sinMotivo = true;
  const otro = await abrirCRM({ estado });
  try {
    await otro.page.click(`.nav-item[onclick="goPage('stock')"]`);
    await otro.page.waitForSelector('#stock-tbody tr');
    await otro.page.click(`#stock-tbody tr:has(.badge:text-is("SKU2")) button[title^="Descatalogar"]`);
    await otro.page.waitForSelector('#modal-discontinuar.open');
    await otro.page.selectOption('#disc-motivo', 'poca_venta');
    await otro.page.click('#disc-guardar');
    await otro.page.waitForSelector('#modal-discontinuar.open', { state: 'hidden' });

    const p = estado.productos.find(x => x.sku === 'SKU2');
    assert.strictEqual(p.discontinuado, true, 'el descatalogado se guarda igual');
    assert.strictEqual(p.motivo_discontinuado, null, 'el motivo no entró: la columna no existe');

    await otro.page.click(`#page-stock .tab:text-is("⛔ Discontinuados")`);
    await otro.page.waitForSelector('#stock-disc-panel:visible');
    const aviso = await otro.page.textContent('#stock-disc-aviso');
    assert.match(aviso, /Falta correr la migración del motivo/);
    assert.match(aviso, /20261008010000_add_motivo_discontinuado\.sql/);
    // No se inventa un motivo que no se guardó.
    assert.match(await otro.page.textContent('#stock-tbody'), /Sin motivo registrado/);

    assert.deepStrictEqual(otro.alertas, [], 'no molesta con alertas: ' + JSON.stringify(otro.alertas));
    const reales = erroresReales(otro.errores);
    assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
  } finally {
    await otro.cerrar();
  }
});
