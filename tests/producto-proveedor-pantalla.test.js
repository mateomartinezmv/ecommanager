// Stock → ✏️ Editar producto: elegir el proveedor (importador) del producto.
//
// Lo que no puede fallar: que guardar el formulario mande el proveedor elegido (y "Sin
// proveedor" lo saque), y que sin proveedores cargados el campo no aparezca y el guardado
// no lo mande, para no borrarle a nadie el que le puso Importaciones.

const { test } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, estadoDemo, erroresReales } = require('./helpers');

const PROVEEDORES = [
  { id: 'PROV-HONGPA', nombre: 'HONGPA', minimo_usd: 300 },
  { id: 'PROV-TOM', nombre: 'Tom Banana', minimo_usd: 300 },
];

async function editar(page, sku) {
  await page.click(`.nav-item[onclick="goPage('stock')"]`);
  await page.click(`button[data-sku="${sku}"][onclick^="editProducto"]`);
  await page.waitForSelector('#modal-producto.open');
}

test('el formulario de producto deja elegir el proveedor y lo guarda', async () => {
  const estado = estadoDemo();
  estado.proveedores = PROVEEDORES;
  estado.productos.find(p => p.sku === 'SKU2').proveedor_id = 'PROV-TOM';
  const crm = await abrirCRM({ estado });
  try {
    const { page } = crm;
    // Un producto sin proveedor: el campo aparece con las opciones y en "Sin proveedor".
    await editar(page, 'SKU1');
    assert.ok(await page.isVisible('#p-proveedor'));
    const opciones = await page.$$eval('#p-proveedor option', os => os.map(o => o.textContent.trim()));
    assert.deepStrictEqual(opciones, ['— Sin proveedor —', '🏭 HONGPA', '🏭 Tom Banana']);
    assert.strictEqual(await page.inputValue('#p-proveedor'), '');
    await page.selectOption('#p-proveedor', 'PROV-HONGPA');
    await page.click('#modal-producto button:has-text("Guardar")');
    await page.waitForSelector('#modal-producto.open', { state: 'hidden' });
    const put = estado.productosPut.find(x => x.sku === 'SKU1');
    assert.strictEqual(put.proveedorId, 'PROV-HONGPA');
    assert.strictEqual(estado.productos.find(p => p.sku === 'SKU1').proveedor_id, 'PROV-HONGPA');

    // Al volver a abrirlo, viene con el que se guardó; el otro trae el suyo.
    await editar(page, 'SKU1');
    assert.strictEqual(await page.inputValue('#p-proveedor'), 'PROV-HONGPA');
    await page.click('#modal-producto button:has-text("Cancelar")');
    await editar(page, 'SKU2');
    assert.strictEqual(await page.inputValue('#p-proveedor'), 'PROV-TOM');
    // "Sin proveedor" se lo saca.
    await page.selectOption('#p-proveedor', '');
    await page.click('#modal-producto button:has-text("Guardar")');
    await page.waitForSelector('#modal-producto.open', { state: 'hidden' });
    assert.strictEqual(estado.productosPut.filter(x => x.sku === 'SKU2').pop().proveedorId, null);
    assert.strictEqual(estado.productos.find(p => p.sku === 'SKU2').proveedor_id, null);
    assert.deepStrictEqual(erroresReales(crm.errores), []);
  } finally {
    await crm.cerrar();
  }
});

test('sin proveedores cargados el campo no aparece y el guardado no lo pisa', async () => {
  const estado = estadoDemo();
  estado.productos.find(p => p.sku === 'SKU1').proveedor_id = 'PROV-ASIGNADO-EN-IMPORTACIONES';
  const crm = await abrirCRM({ estado });
  try {
    const { page } = crm;
    await editar(page, 'SKU1');
    assert.ok(await page.isHidden('#p-proveedor-grupo'));
    await page.click('#modal-producto button:has-text("Guardar")');
    await page.waitForSelector('#modal-producto.open', { state: 'hidden' });
    assert.ok(!('proveedorId' in estado.productosPut.find(x => x.sku === 'SKU1')));
    assert.strictEqual(estado.productos.find(p => p.sku === 'SKU1').proveedor_id, 'PROV-ASIGNADO-EN-IMPORTACIONES');
    assert.deepStrictEqual(erroresReales(crm.errores), []);
  } finally {
    await crm.cerrar();
  }
});
