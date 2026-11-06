// El desplegable "Márgenes de la venta" al pie de "Editar venta".
//
// Lo que se protege: que arranque cerrado, que la cuenta sea la misma que en Reportes
// (total − comisión − costo del producto − envío propio + colecta), que el envío de un
// carrito se reparta entre sus líneas, que avise cuando el producto no tiene costo y que se
// recalcule mientras se edita el formulario, sin guardar nada.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { HOY, estadoDemo, abrirCRM, erroresReales } = require('./helpers');

let ctx;

before(async () => {
  const estado = estadoDemo();
  const mos = (id, extra) => ({ id, canal: 'mostrador', fecha: HOY, cliente: 'Juan', cliente_id: null,
    sku: 'SKU1', producto: 'Slider', cantidad: 1, precio_unit: 1000, comision: 0, total: 1000,
    estado: 'pagada', metodo_pago: 'efectivo', created_at: HOY, ...extra });
  estado.productos.push({ sku: 'SKU-SC', nombre: 'Sin costo', tipo: 'nuevo', stock_dep: 1, stock_meli: 0,
    stock_shopify: 0, costo: 0, precio: 500, alerta_min: 0, discontinuado: false, created_at: HOY });
  estado.ventas.push(
    // Carrito: 1000 + 3000, con un envío de 300 + colecta.
    mos('V-C1', { venta_grupo: 'G1' }),
    mos('V-C2', { venta_grupo: 'G1', sku: 'SKU2', producto: 'Espejo redondo', cantidad: 3, total: 3000 }),
    mos('V-SC', { sku: 'SKU-SC', producto: 'Sin costo', precio_unit: 500, total: 500 }),
  );
  estado.envios = [
    { id: 'E-C', venta_id: 'V-C1', orden: 'V-C1', comprador: 'Juan', producto: 'Slider', transportista: 'ues',
      estado: 'pendiente', direccion: 'Rivera 1234', costo: 300, colecta: true, created_at: HOY },
  ];
  ctx = await abrirCRM({ estado });
});

after(async () => { await ctx.cerrar(); });

const filas = () => ctx.page.$$eval('#ev-mg-body .ev-mg-row', rs => Object.fromEntries(rs.map(r => [
  r.querySelector('.ev-mg-lbl').firstChild.textContent.trim(), r.querySelector('.ev-mg-val').textContent.trim(),
])));

test('arranca cerrado y la venta MELI cuenta comisión y costo', async () => {
  const { page } = ctx;
  await page.evaluate(() => abrirEdicionVenta('V-1'));
  assert.strictEqual(await page.$eval('#ev-margenes', d => d.open), false);
  await page.click('#ev-margenes summary');
  assert.strictEqual(await page.$eval('#ev-margenes', d => d.open), true);
  // 2 × 1000 − 300 comisión − 2 × 400 costo = 900 (45%).
  const f = await filas();
  assert.strictEqual(f['Costo del producto'], '−$800');
  assert.strictEqual(f['Margen bruto'], '$1.200');
  assert.strictEqual(f['Ganancia neta'], '$900');
  assert.match(await page.textContent('#ev-mg-resumen'), /\$900 · 45,0%/);
  await page.evaluate(() => closeModal('modal-editar-venta'));
  // Al volver a abrir, otra vez cerrado.
  await page.evaluate(() => abrirEdicionVenta('V-1'));
  assert.strictEqual(await page.$eval('#ev-margenes', d => d.open), false);
  await page.evaluate(() => closeModal('modal-editar-venta'));
});

test('el envío del carrito se reparte por lo que factura cada línea', async () => {
  const { page } = ctx;
  await page.evaluate(() => abrirEdicionVenta('V-C2'));
  // (300 + 75 colecta) × 3000 / 4000 = 281,25
  const f = await filas();
  assert.strictEqual(f['Costo de envío'], '−$281,25');
  // 3000 − 3 × 250 − 281,25 = 1968,75
  assert.strictEqual(f['Ganancia neta'], '$1.968,75');
  assert.match(await page.textContent('#ev-mg-body'), /prorrateado entre 2 productos/);
  await page.evaluate(() => closeModal('modal-editar-venta'));
});

test('se recalcula mientras se edita y avisa si no hay costo', async () => {
  const { page, estado } = ctx;
  await page.evaluate(() => abrirEdicionVenta('V-1'));
  await page.fill('#ev-precio', '1500');
  await page.fill('#ev-comision', '450');
  // 3000 − 450 − 800 = 1750
  assert.strictEqual((await filas())['Ganancia neta'], '$1.750');
  await page.evaluate(() => closeModal('modal-editar-venta'));
  // No se guardó nada por mirar los márgenes.
  assert.strictEqual(estado.ventas.find(v => v.id === 'V-1').precio_unit, 1000);

  await page.evaluate(() => abrirEdicionVenta('V-SC'));
  assert.match(await page.textContent('#ev-mg-resumen'), /sin costo/);
  assert.match(await page.textContent('#ev-mg-body'), /no tiene costo cargado/);
  await page.evaluate(() => closeModal('modal-editar-venta'));
});

test('sin errores de consola', () => {
  assert.deepStrictEqual(erroresReales(ctx.errores), []);
});
