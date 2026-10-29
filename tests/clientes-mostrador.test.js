// El cliente de una venta de mostrador: que la compra quede en la ficha del cliente.
//
// Lo que se protege: que el buscador del modal encuentre al cliente aunque se escriba
// distinto (sin tildes, Cristian por Kristian, sólo nombre y apellido), que con Enter se
// elija la sugerencia, que la venta viaje con su clienteId, que escribir el nombre exacto
// sin tocar la sugerencia la vincule igual, que con un nombre parecido se pregunte, y que
// corregir el nombre en "Editar venta" la pase a la ficha de ese cliente. Y que el
// destinatario del envío y el cliente de la venta sean el mismo: elegirlo en el envío se lo
// pone a todas las líneas de la venta, y corregirlo en la venta renombra al destinatario.

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
  estado.clientes.push({ id: 'CLI-P', nombre: 'Pedro Gasamans', telefono: '099186807', canal_origen: 'mostrador', created_at: HOY });
  const mos = (id, extra) => ({ id, canal: 'mostrador', fecha: HOY, cliente: null, cliente_id: null,
    sku: 'SKU1', producto: 'Slider', cantidad: 1, precio_unit: 1000, comision: 0, total: 1000,
    estado: 'pagada', metodo_pago: 'efectivo', created_at: HOY, ...extra });
  estado.ventas.push(
    mos('V-MOS', { cliente: 'rodri' }),
    // Venta cargada sin cliente que después se mandó: el destinatario está sólo en el envío.
    mos('V-SC'),
    // Carrito de dos productos, todavía sin envío.
    mos('V-C1', { venta_grupo: 'G1' }), mos('V-C2', { venta_grupo: 'G1', sku: 'SKU2', producto: 'Espejo redondo' }),
    // Venta con su envío, para corregir el nombre desde la venta.
    mos('V-E2', { cliente: 'Juan' }),
  );
  estado.envios = [
    { id: 'E-1', venta_id: 'V-SC', orden: 'V-SC', comprador: '', producto: 'Slider', transportista: 'ues',
      estado: 'entregado', direccion: 'Calle 5 entre 19 y 18, Piriápolis', costo: 300, created_at: HOY },
    { id: 'E-2', venta_id: 'V-E2', orden: 'V-E2', comprador: 'Juan', producto: 'Slider', transportista: 'ues',
      estado: 'pendiente', direccion: 'Rivera 1234', costo: 300, created_at: HOY },
    { id: 'E-M', venta_id: 'V-1', orden: '2000012345', comprador: 'NICKMELI', producto: 'Slider', transportista: 'mercado_envios',
      estado: 'pendiente', direccion: null, costo: 0, created_at: HOY },
  ];
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
  return ctx.page.$$eval('#vmos-cliente-dd .cli-opt', els => els.map(e => e.dataset.id));
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
  assert.strictEqual(await page.$('#vmos-cliente-dd .cli-nuevo'), null);
  await page.fill('#vmos-cliente-search', 'Cliente Nuevo');
  assert.ok(await page.$('#vmos-cliente-dd .cli-nuevo'));
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

test('el destinatario elegido al editar el envío pasa a la venta y a la ficha del cliente', async () => {
  const { page, estado } = ctx;
  await page.evaluate(() => abrirEdicionEnvio('E-1'));
  await page.click('#ee-comprador');
  await page.keyboard.type('pedro gasa');
  assert.strictEqual((await page.$$eval('#ee-cliente-dd .cli-opt', els => els.map(e => e.dataset.id)))[0], 'CLI-P');
  await page.keyboard.press('Enter');
  assert.match(await page.textContent('#ee-cliente-estado'), /ficha de Pedro Gasamans/);
  estado.ventasPut = []; estado.enviosPut = [];
  await page.evaluate(() => guardarEdicionEnvio());
  await page.waitForTimeout(300);
  assert.strictEqual(estado.enviosPut[0].comprador, 'Pedro Gasamans');
  assert.strictEqual(estado.enviosPut[0].estado, 'entregado', 'el resto del envío no cambia');
  assert.deepStrictEqual(estado.ventasPut, [{ id: 'V-SC', cliente: 'Pedro Gasamans', clienteId: 'CLI-P' }]);
});

test('el envío de un carrito le pone el cliente a todas sus líneas', async () => {
  const { page, estado } = ctx;
  await page.evaluate(() => abrirEnvioDeCarrito('G:G1'));
  await page.fill('#env-comprador', 'kristian quiros');   // exacto, sin elegir de la lista
  estado.ventasPut = [];
  await page.evaluate(() => saveEnvio());
  await page.waitForTimeout(300);
  const envio = estado.envios.find(e => e.venta_id === 'V-C1');
  assert.strictEqual(envio.comprador, 'Kristian Quiros');
  assert.deepStrictEqual(estado.ventasPut.map(p => [p.id, p.cliente, p.clienteId]).sort(),
    [['V-C1', 'Kristian Quiros', 'CLI-K'], ['V-C2', 'Kristian Quiros', 'CLI-K']]);
});

test('corregir el cliente en la venta renombra al destinatario del envío', async () => {
  const { page, estado } = ctx;
  await page.evaluate(() => abrirEdicionVenta('V-E2'));
  await page.fill('#ev-comprador', 'Rodrigo Román');
  estado.ventasPut = []; estado.enviosPut = [];
  await page.evaluate(() => guardarEdicionVenta());
  await page.waitForTimeout(300);
  assert.strictEqual(estado.ventasPut[0].clienteId, 'CLI-R');
  assert.deepStrictEqual(estado.enviosPut, [{ id: 'E-2', comprador: 'Rodrigo Román' }]);
});

test('en un envío de MELI el comprador es el nickname: no se busca ni se toca la venta', async () => {
  const { page, estado } = ctx;
  await page.evaluate(() => abrirEdicionEnvio('E-M'));
  await page.fill('#ee-comprador', 'Kristian');
  assert.strictEqual(await page.isVisible('#ee-cliente-dd'), false);
  estado.ventasPut = []; estado.enviosPut = [];
  await page.evaluate(() => guardarEdicionEnvio());
  await page.waitForTimeout(300);
  assert.strictEqual(estado.enviosPut[0].comprador, 'Kristian');
  assert.deepStrictEqual(estado.ventasPut, []);
});

test('sin errores de consola', () => {
  assert.deepStrictEqual(erroresReales(ctx.errores), []);
});
