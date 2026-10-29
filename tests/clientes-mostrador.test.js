// El cliente de una venta de mostrador: que la compra quede en la ficha del cliente.
//
// Lo que se protege: que el buscador del modal encuentre al cliente aunque se escriba
// distinto (sin tildes, Cristian por Kristian, sólo nombre y apellido), que con Enter se
// elija la sugerencia, que la venta viaje con su clienteId, que escribir el nombre exacto
// sin tocar la sugerencia la vincule igual, que con un nombre parecido se pregunte, y que
// corregir el nombre en "Editar venta" la pase a la ficha de ese cliente.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { HOY, estadoDemo, abrirCRM, erroresReales } = require('./helpers');

let ctx;

before(async () => {
  const estado = estadoDemo();
  estado.clientes = [
    { id: 'CLI-K', nombre: 'Kristian Quiros', telefono: '098593229', canal_origen: 'mostrador', created_at: HOY },
    { id: 'CLI-J', nombre: 'Juan Alberto Gutierrez Martinez', telefono: '099521876', canal_origen: 'mostrador', created_at: HOY },
    { id: 'CLI-R', nombre: 'Rodrigo Román', telefono: null, canal_origen: 'mostrador', created_at: HOY },
  ];
  estado.ventas.push({ id: 'V-MOS', canal: 'mostrador', fecha: HOY, cliente: 'rodri', cliente_id: null,
    sku: 'SKU1', producto: 'Slider', cantidad: 1, precio_unit: 1000, comision: 0, total: 1000,
    estado: 'pagada', metodo_pago: 'efectivo', created_at: HOY });
  ctx = await abrirCRM({ estado });
  // jsPDF viene de un CDN que no carga sin red; el comprobante no es lo que se prueba.
  await ctx.page.evaluate(() => { generarComprobantePDF = () => {}; });
});

after(async () => { await ctx.cerrar(); });

async function abrirModalConProducto() {
  const { page } = ctx;
  await page.evaluate(() => vmosOpenModal());
  await page.fill('#vmos-search', 'Slider');
  await page.evaluate(() => vmosPickFromDropdown(0));
  await page.evaluate(() => vmosAddToCart());
}

async function sugerencias() {
  return ctx.page.$$eval('#vmos-cliente-dd .vmos-cli-opt', els => els.map(e => e.dataset.id));
}

test('el buscador encuentra al cliente aunque se escriba distinto', async () => {
  const { page } = ctx;
  await page.evaluate(() => vmosOpenModal());
  for (const [escrito, esperado] of [['crist', 'CLI-K'], ['KRISTIAN', 'CLI-K'], ['juan martinez', 'CLI-J'], ['roman', 'CLI-R'], ['0985', 'CLI-K']]) {
    await page.fill('#vmos-cliente-search', escrito);
    assert.strictEqual((await sugerencias())[0], esperado, `"${escrito}" tendría que sugerir ${esperado}`);
  }
  // Con un cliente que ya se llama así no se ofrece crear un duplicado.
  await page.fill('#vmos-cliente-search', 'rodrigo roman');
  assert.strictEqual(await page.$('#vmos-cliente-dd .vmos-cli-nuevo'), null);
  await page.fill('#vmos-cliente-search', 'Cliente Nuevo');
  assert.ok(await page.$('#vmos-cliente-dd .vmos-cli-nuevo'));
});

test('Enter elige la sugerencia y la venta se guarda con su clienteId', async () => {
  const { page, estado } = ctx;
  await abrirModalConProducto();
  await page.click('#vmos-cliente-search');
  await page.keyboard.type('crist');
  await page.keyboard.press('Enter');
  assert.strictEqual(await page.inputValue('#vmos-cliente-search'), 'Kristian Quiros');
  assert.match(await page.textContent('#vmos-cliente-estado'), /ficha de Kristian Quiros/);

  estado.ventasPost = [];
  await page.evaluate(() => saveVenta('mostrador'));
  await page.waitForFunction(() => !document.getElementById('modal-venta-mostrador').classList.contains('open'));
  await page.waitForTimeout(200);
  assert.strictEqual(estado.ventasPost.length, 1);
  assert.strictEqual(estado.ventasPost[0].clienteId, 'CLI-K');
  assert.strictEqual(estado.ventasPost[0].cliente, 'Kristian Quiros');
});

test('el nombre exacto sin elegir la sugerencia vincula igual', async () => {
  const { page, estado, alertas } = ctx;
  await abrirModalConProducto();
  await page.fill('#vmos-cliente-search', 'juan alberto gutiérrez martínez');
  estado.ventasPost = [];
  const antes = alertas.length;
  await page.evaluate(() => saveVenta('mostrador'));
  await page.waitForTimeout(300);
  assert.strictEqual(alertas.length, antes, 'con el nombre exacto no hay nada que preguntar');
  assert.strictEqual(estado.ventasPost[0].clienteId, 'CLI-J');
  assert.strictEqual(estado.ventasPost[0].cliente, 'Juan Alberto Gutierrez Martinez');
});

test('con un nombre parecido se pregunta antes de guardarla suelta', async () => {
  const { page, estado, alertas } = ctx;
  await abrirModalConProducto();
  await page.fill('#vmos-cliente-search', 'Cristian Quiroz');
  estado.ventasPost = [];
  const antes = alertas.length;
  await page.evaluate(() => saveVenta('mostrador'));   // el diálogo se acepta solo
  await page.waitForTimeout(300);
  assert.match(alertas[antes] || '', /Kristian Quiros/);
  assert.strictEqual(estado.ventasPost[0].clienteId, 'CLI-K');
});

test('sin cliente parecido la venta se guarda sin vincular', async () => {
  const { page, estado, alertas } = ctx;
  await abrirModalConProducto();
  await page.fill('#vmos-cliente-search', 'Zacarías Pérez');
  estado.ventasPost = [];
  const antes = alertas.length;
  await page.evaluate(() => saveVenta('mostrador'));
  await page.waitForTimeout(300);
  assert.strictEqual(alertas.length, antes);
  assert.strictEqual(estado.ventasPost[0].clienteId, null);
  assert.strictEqual(estado.ventasPost[0].cliente, 'Zacarías Pérez');
});

test('corregir el nombre en Editar venta la pasa a la ficha del cliente', async () => {
  const { page, estado } = ctx;
  await page.evaluate(() => abrirEdicionVenta('V-MOS'));
  await page.fill('#ev-comprador', 'Rodrigo Roman');
  estado.ventasPut = [];
  await page.evaluate(() => guardarEdicionVenta());
  await page.waitForTimeout(300);
  assert.strictEqual(estado.ventasPut[0].id, 'V-MOS');
  assert.strictEqual(estado.ventasPut[0].clienteId, 'CLI-R');
});

test('sin errores de consola', () => {
  assert.deepStrictEqual(erroresReales(ctx.errores), []);
});
