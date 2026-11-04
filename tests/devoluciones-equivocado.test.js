// ↩️ Devoluciones → 📦 producto equivocado, manejado como lo maneja el usuario: el cliente
// pidió el Slider (SKU1, la venta V-1), le mandamos el Espejo redondo (SKU2) y lo devuelve.
//
// Lo que se protege: que el formulario deje elegir qué recibió el cliente, que registrar
// descuente ese producto y confirmar se lo vuelva a sumar (el Slider no se toca: se le
// reenvía con el descuento de la venta), que la tabla muestre qué pidió y qué recibió,
// que borrar una pendiente devuelva lo descontado, las validaciones del formulario, que una
// devolución común siga igual, y el estado sin la migración.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { estadoDemo, abrirCRM, erroresReales } = require('./helpers');

let crm;
const stock = sku => crm.estado.productos.find(p => p.sku === sku).stock_dep;
const nuevas = () => crm.estado.devoluciones || [];

before(async () => { crm = await abrirCRM({ estado: estadoDemo() }); });
after(async () => { if (crm) await crm.cerrar(); });

async function abrirFormulario(page) {
  await page.click(`.nav-item[onclick="goPage('ventas')"]`);
  await page.click(`button[onclick="openCrearDevolucion('V-1')"]`);
  await page.waitForSelector('#modal-devolucion.open');
  await page.fill('#dev-cantidad', '1');
}

// Los alert()/confirm() se anotan del lado de Node, así que se espera a que aparezcan.
async function esperarAlertas(n) {
  for (let i = 0; i < 50 && crm.alertas.length < n; i++) await new Promise(r => setTimeout(r, 50));
}

test('el producto equivocado está oculto hasta tildarlo y muestra lo que se eligió', async () => {
  const { page } = crm;
  await abrirFormulario(page);
  assert.ok(!(await page.isVisible('#dev-sku-recibido')));
  await page.check('#dev-equivocado');
  assert.ok(await page.isVisible('#dev-sku-recibido'));
  const opciones = await page.$$eval('#dl-dev-productos option', os => os.map(o => o.value));
  assert.ok(!opciones.includes('SKU1'), 'el producto que pidió no se ofrece');
  assert.ok(opciones.includes('SKU2'));
  await page.fill('#dev-sku-recibido', 'SKU2');
  assert.match(await page.textContent('#dev-recibido-info'), /Espejo redondo/);
});

test('sin elegir producto, o eligiendo el mismo que pidió, no se registra', async () => {
  const { page } = crm;
  await page.fill('#dev-sku-recibido', '');
  await page.click('#modal-devolucion .btn-primary');
  await esperarAlertas(1);
  assert.match(crm.alertas.pop(), /Elegí qué producto recibió/);
  await page.fill('#dev-sku-recibido', 'SKU1');
  await page.click('#modal-devolucion .btn-primary');
  await esperarAlertas(1);
  assert.match(crm.alertas.pop(), /mismo que pidió/);
  assert.strictEqual(nuevas().length, 0);
});

test('registrarla descuenta el producto que recibió el cliente, no el que pidió', async () => {
  const { page } = crm;
  await page.fill('#dev-sku-recibido', 'SKU2');
  await page.click('#modal-devolucion .btn-primary');
  await page.waitForSelector('#page-devoluciones.active');

  const dev = nuevas()[0];
  assert.deepStrictEqual([dev.sku, dev.sku_recibido], ['SKU1', 'SKU2']);
  assert.strictEqual(stock('SKU2'), 3, '4 − 1: el espejo está en lo del cliente');
  assert.strictEqual(stock('SKU1'), 10, 'el slider no se toca');

  const fila = await page.textContent(`#devoluciones-tbody tr:has-text("${dev.id}")`);
  assert.match(fila, /Pidió:\s*Slider/);
  assert.match(fila, /Recibió \(equivocado\):\s*Espejo redondo/);
});

test('confirmar que llegó le suma al producto equivocado', async () => {
  const { page } = crm;
  const dev = nuevas()[0];
  await page.click(`button[onclick="confirmarDevolucion('${dev.id}')"]`);
  await esperarAlertas(2);
  const [pregunta, aviso] = crm.alertas.splice(0, 2);
  assert.match(pregunta, /recibiste fisicamente "Espejo redondo"/);
  assert.match(aviso, /Nuevo stock de "Espejo redondo": 4/);
  assert.strictEqual(stock('SKU2'), 4, 'volvió a como estaba antes del error');
  assert.strictEqual(stock('SKU1'), 10);
  assert.strictEqual(dev.estado, 'recibida');
});

test('borrar una pendiente le devuelve lo descontado al producto equivocado', async () => {
  const { page } = crm;
  await abrirFormulario(page);
  await page.check('#dev-equivocado');
  await page.fill('#dev-sku-recibido', 'SKU2');
  await page.click('#modal-devolucion .btn-primary');
  await page.waitForSelector('#page-devoluciones.active');
  await page.waitForFunction(() => db.devoluciones.length === 2);
  assert.strictEqual(stock('SKU2'), 3);

  const dev = nuevas().find(d => d.estado === 'pendiente');
  await page.click('#tab-dev-pendiente');
  await page.click(`button[onclick="deleteDevolucion('${dev.id}')"]`);
  await esperarAlertas(1);
  assert.match(crm.alertas.shift(), /Se le devuelven 1 unidad\(es\) a "Espejo redondo"/);
  await page.waitForFunction(() => db.devoluciones.length === 1);
  assert.strictEqual(stock('SKU2'), 4);
});

test('una devolución común sigue sumándole al producto de la venta', async () => {
  const { page } = crm;
  await abrirFormulario(page);
  await page.click('#modal-devolucion .btn-primary');
  await page.waitForSelector('#page-devoluciones.active');
  await page.waitForFunction(() => db.devoluciones.length === 2);
  const dev = nuevas().find(d => d.estado === 'pendiente');
  assert.strictEqual(dev.sku_recibido, undefined);
  assert.strictEqual(stock('SKU1'), 10, 'registrarla no mueve stock');
  await page.click(`button[onclick="confirmarDevolucion('${dev.id}')"]`);
  await esperarAlertas(2);
  crm.alertas.splice(0, 2);
  assert.strictEqual(stock('SKU1'), 11);
  assert.strictEqual(stock('SKU2'), 4);
});

test('no hubo errores ni alertas de más', () => {
  assert.deepStrictEqual(crm.alertas, [], 'alertas inesperadas: ' + JSON.stringify(crm.alertas));
  const reales = erroresReales(crm.errores);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});

test('sin la migración avisa qué falta y no descuenta nada', async () => {
  const estado = estadoDemo();
  estado.sinSkuRecibido = true;
  const otro = await abrirCRM({ estado });
  try {
    await otro.page.click(`.nav-item[onclick="goPage('ventas')"]`);
    await otro.page.click(`button[onclick="openCrearDevolucion('V-1')"]`);
    await otro.page.waitForSelector('#modal-devolucion.open');
    await otro.page.check('#dev-equivocado');
    await otro.page.fill('#dev-sku-recibido', 'SKU2');
    await otro.page.click('#modal-devolucion .btn-primary');
    for (let i = 0; i < 50 && !otro.alertas.length; i++) await new Promise(r => setTimeout(r, 50));
    assert.match(otro.alertas[0] || '', /20261105000000_add_sku_recibido_devoluciones\.sql/);
    assert.strictEqual((estado.devoluciones || []).length, 0);
    assert.strictEqual(estado.productos.find(p => p.sku === 'SKU2').stock_dep, 4);
    assert.ok(await otro.page.isVisible('#modal-devolucion'), 'el formulario sigue abierto para reintentar');
  } finally { await otro.cerrar(); }
});
