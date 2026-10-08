// Descatalogar un producto: que salga de reposición y que quede registrado POR QUÉ.
//
// Lo que se verifica acá es lo que el usuario no puede ver desde la pantalla: qué quedó
// guardado en la base (el motivo, la nota, la fecha) y que editar el producto después no se
// lo lleve puesto. El análisis por motivo y por grupo se lee de la pantalla, porque es la
// razón de ser de la feature: ver qué estilo de producto no funciona.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { HOY, abrirCRM, erroresReales, leerTarjetas } = require('./helpers');

let crm;
const valor = (tarjetas, etiqueta) => (tarjetas.find(t => t.etiqueta.startsWith(etiqueta)) || {}).valor;
const prod = (estado, sku) => estado.productos.find(p => p.sku === sku);

// Abre el modal de descatalogado desde el botón ⛔ de la fila del SKU.
async function abrirDescatalogar(page, sku) {
  await page.click(`#stock-tbody tr:has(.badge:text-is("${sku}")) button[title^="Descatalogar"]`);
  await page.waitForSelector('#modal-discontinuar.open');
}

async function descatalogar(page, sku, motivo, nota) {
  await abrirDescatalogar(page, sku);
  await page.selectOption('#disc-motivo', motivo);
  if (nota) await page.fill('#disc-nota', nota);
  await page.click('#disc-guardar');
  await page.waitForSelector('#modal-discontinuar.open', { state: 'hidden' });
}

before(async () => {
  crm = await abrirCRM();
  await crm.page.click(`.nav-item[onclick="goPage('stock')"]`);
  await crm.page.waitForSelector('#stock-tbody tr');
});

after(async () => { if (crm) await crm.cerrar(); });

test('descatalogar guarda el motivo, la nota y la fecha', async () => {
  await descatalogar(crm.page, 'SKU2', 'poca_venta', 'quedó parado desde marzo');
  const p = prod(crm.estado, 'SKU2');
  assert.strictEqual(p.discontinuado, true);
  assert.strictEqual(p.motivo_discontinuado, 'poca_venta');
  assert.strictEqual(p.nota_discontinuado, 'quedó parado desde marzo');
  assert.strictEqual(p.fecha_discontinuado, HOY);
});

test('sin elegir motivo no se descataloga nada', async () => {
  await abrirDescatalogar(crm.page, 'SKU3');
  await crm.page.click('#disc-guardar');
  assert.match(crm.alertas.pop() || '', /Elegí un motivo/);
  assert.ok(await crm.page.isVisible('#modal-discontinuar'), 'el modal sigue abierto');
  assert.strictEqual(prod(crm.estado, 'SKU3').discontinuado, false, 'no se guardó nada');
  await crm.page.click(`#modal-discontinuar button:text-is("Cancelar")`);
  await crm.page.waitForSelector('#modal-discontinuar.open', { state: 'hidden' });
});

test('"Otro motivo" exige la aclaración', async () => {
  await abrirDescatalogar(crm.page, 'SKU3');
  await crm.page.selectOption('#disc-motivo', 'otro');
  await crm.page.click('#disc-guardar');
  assert.match(crm.alertas.pop() || '', /aclaración/);
  assert.strictEqual(prod(crm.estado, 'SKU3').discontinuado, false);
  await crm.page.click(`#modal-discontinuar button:text-is("Cancelar")`);
  await crm.page.waitForSelector('#modal-discontinuar.open', { state: 'hidden' });
});

test('un producto descatalogado sale de la lista y de los avisos de stock bajo', async () => {
  const skus = await crm.page.$$eval('#stock-tbody tr td:first-child', tds => tds.map(t => t.textContent.trim()));
  assert.ok(!skus.includes('SKU2'), 'ya no está en la pestaña Todos: ' + skus.join(', '));

  // SKU2 tenía stock 4 con alerta 2 — no estaba en stock bajo. SKU3 está en 0 y sí aparece:
  // lo que importa es que al descatalogarlo se vaya.
  await descatalogar(crm.page, 'SKU3', 'problematico');
  await crm.page.click(`.nav-item[onclick="goPage('dashboard')"]`);
  await crm.page.waitForSelector('#dash-stats .stat-card');
  const bajos = await crm.page.textContent('#dash-low-stock');
  assert.ok(!bajos.includes('SKU3'), 'un descatalogado no tiene que pedir reposición');
  await crm.page.click(`.nav-item[onclick="goPage('stock')"]`);
  await crm.page.waitForSelector('#stock-tbody tr');
});

test('la pestaña ⛔ los lista con su motivo y deja filtrar por él', async () => {
  await crm.page.click(`#page-stock .tab:text-is("⛔ Discontinuados")`);
  await crm.page.waitForSelector('#stock-disc-panel:visible');
  const filas = await crm.page.$$eval('#stock-tbody tr', trs => trs.map(t => t.textContent));
  assert.strictEqual(filas.length, 2);
  assert.ok(filas.some(f => f.includes('SKU2') && f.includes('Poca venta')));
  assert.ok(filas.some(f => f.includes('SKU3') && f.includes('Producto problemático')));

  await crm.page.selectOption('#stock-motivo', 'poca_venta');
  const filtradas = await crm.page.$$eval('#stock-tbody tr td:first-child', tds => tds.map(t => t.textContent.trim()));
  assert.deepStrictEqual(filtradas, ['SKU2']);
  await crm.page.selectOption('#stock-motivo', '');
});

test('el análisis resume el capital parado y el motivo más frecuente', async () => {
  const tarjetas = await leerTarjetas(crm.page, '#stock-disc-stats');
  assert.strictEqual(valor(tarjetas, 'Descatalogados sobre 3'), '2');
  // Sólo SKU2 quedó con stock (4 uds × $250). SKU3 estaba en 0, así que no inmoviliza nada.
  assert.strictEqual(valor(tarjetas, 'Unidades por liquidar'), '4');
  assert.strictEqual(valor(tarjetas, 'Costo inmovilizado'), '$1.000');
  // Empate 1 a 1 entre los dos motivos: lo que importa es que muestre uno de los cargados.
  assert.match(valor(tarjetas, 'Motivo más frecuente') || '', /Poca venta|Producto problemático/);
  // Los dos descatalogados son del grupo Espejos: 2 de 2.
  assert.strictEqual(valor(tarjetas, 'Grupo más castigado'), 'Espejos');
  assert.match(tarjetas.find(t => t.etiqueta.startsWith('Grupo más castigado')).etiqueta, /2 de 2/);
});

test('el gráfico y el panel por grupo cuentan productos, no pesos', async () => {
  const donut = await crm.page.textContent('#stock-disc-donut');
  assert.ok(!donut.includes('$'), 'el donut de motivos cuenta productos: ' + donut);
  assert.match(donut, /Poca venta/);

  const grupos = await crm.page.textContent('#stock-disc-grupos');
  assert.match(grupos, /Espejos/);
  assert.match(grupos, /2\/2/);
  assert.match(grupos, /Redondos/);
  assert.match(grupos, /Cuadrados/);
});

test('editar el producto no lo reactiva ni le borra el motivo', async () => {
  await crm.page.click(`#stock-tbody tr:has(.badge:text-is("SKU2")) button[onclick^="editProducto"]`);
  await crm.page.waitForSelector('#modal-producto.open');
  await crm.page.fill('#p-precio', '1234');
  await crm.page.click(`#modal-producto button:text-is("Guardar producto")`);
  await crm.page.waitForSelector('#modal-producto.open', { state: 'hidden' });

  const p = prod(crm.estado, 'SKU2');
  assert.strictEqual(p.precio, 1234, 'el cambio del formulario se guardó');
  assert.strictEqual(p.discontinuado, true, 'sigue descatalogado');
  assert.strictEqual(p.motivo_discontinuado, 'poca_venta', 'conservó el motivo');
  assert.strictEqual(p.nota_discontinuado, 'quedó parado desde marzo', 'conservó la nota');
});

test('reactivar borra el motivo y lo devuelve al catálogo', async () => {
  // El confirm lo acepta el handler de dialogs de abrirCRM, que además lo anota en `alertas`.
  await crm.page.click(`#stock-tbody tr:has(.badge:text-is("SKU3")) button[title^="Volver a catalogar"]`);
  await crm.page.waitForFunction(() => !db.productos.find(p => p.sku === 'SKU3').discontinuado);
  assert.match(crm.alertas.pop() || '', /Reposición/, 'avisa qué implica reactivar');

  const p = prod(crm.estado, 'SKU3');
  assert.strictEqual(p.discontinuado, false);
  assert.strictEqual(p.motivo_discontinuado, null, 'no queda un motivo colgado de un producto activo');
  assert.strictEqual(p.fecha_discontinuado, null);
});

test('no hubo errores ni alertas inesperadas', () => {
  // Las dos alertas de validación son las que provocan los tests de arriba, y ya se
  // consumieron con .pop(); lo que quede acá es ruido real.
  assert.deepStrictEqual(crm.alertas, [], 'alertas inesperadas: ' + JSON.stringify(crm.alertas));
  const reales = erroresReales(crm.errores);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});
