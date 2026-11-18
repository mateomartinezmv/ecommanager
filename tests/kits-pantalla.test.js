// 🧩 Kits en la pantalla: par de espejos alerón + protectores de levas.
//
// Lo que se protege: que el kit se vea como kit en Stock (con su stock, que es el de la pieza
// que menos tiene), que el formulario cargue y guarde sus piezas y no deje cargarle stock a
// mano, que guardar un producto común no toque la tabla de kits, y que al despachar un kit se
// pida escanear cada pieza (el kit no tiene caja propia).

const { test } = require('node:test');
const assert = require('node:assert');
const { HOY, abrirCRM, erroresReales } = require('./helpers');

function estadoKits() {
  return {
    productos: [
      { sku: 'HSJ-20121', nombre: 'Espejos Moto Tipo Aleron Grande Aluminio Universal', tipo: 'nuevo', grupo: 'Espejos',
        subgrupo: 'Tipo alerón', stock_dep: 10, stock_meli: 10, costo: 600, precio: 1690, alerta_min: 3,
        meli_ids: ['MLU100'], created_at: HOY },
      { sku: 'HP-Q035B1', nombre: 'Protector De Levas Universal Moto ABS - Negro', tipo: 'nuevo', grupo: 'Protección',
        subgrupo: 'Protectores de levas', stock_dep: 9, stock_meli: 9, costo: 300, precio: 890, alerta_min: 3,
        meli_ids: ['MLU200'], created_at: HOY },
      { sku: 'KIT-ESP-LEVAS', nombre: 'Kit par de espejos alerón + protectores de levas', tipo: 'nuevo', grupo: 'Kits',
        stock_dep: 9, stock_meli: 9, costo: 900, precio: 2450, alerta_min: 0, meli_ids: ['MLU900'], created_at: HOY,
        componentes: [{ sku: 'HSJ-20121', cantidad: 1 }, { sku: 'HP-Q035B1', cantidad: 1 }] },
    ],
    ventas: [
      { id: 'V_MELI_1_MLU900', canal: 'meli', fecha: HOY, orden_meli: '2000000000000900', pack_id: '2000000000000900',
        sku: 'KIT-ESP-LEVAS', producto: 'Kit par de espejos alerón + protectores de levas', meli_item_id: 'MLU900',
        comprador: 'Lucía Pérez', cantidad: 1, precio_unit: 2450, comision: 350, total: 2450, estado: 'pagada',
        metodo_pago: 'mercadopago', created_at: HOY },
    ],
    envios: [
      { id: 'E_MELI_900', venta_id: 'V_MELI_1_MLU900', orden: '2000000000000900', pack_id: '2000000000000900',
        comprador: 'Lucía Pérez', producto: 'Kit par de espejos alerón + protectores de levas',
        transportista: 'mercado_envios', tracking: 'MEL41110000900FMDOF01', estado: 'pendiente', created_at: HOY },
    ],
  };
}

async function escanear(page, codigo) {
  await page.keyboard.type(codigo);
  await page.keyboard.press('Enter');
}

test('kits en Stock y en el despacho', async (t) => {
  const crm = await abrirCRM({ estado: estadoKits() });
  t.after(() => crm.cerrar());
  const { page, estado } = crm;

  await t.test('Stock marca el kit y explica de dónde sale su stock', async () => {
    await page.click(`.nav-item[onclick="goPage('stock')"]`);
    const fila = page.locator('tr:has-text("KIT-ESP-LEVAS")').first();
    await fila.waitFor();
    assert.match(await fila.textContent(), /🧩 Kit/);
    const titulo = await fila.locator('span:has-text("🧩 Kit")').getAttribute('title');
    assert.match(titulo, /HSJ-20121 ×1 \(10 en depósito\)/);
    assert.match(titulo, /HP-Q035B1 ×1 \(9 en depósito\)/);
  });

  await t.test('el formulario trae las piezas y no deja cargar stock a mano', async () => {
    await page.click('button[data-sku="KIT-ESP-LEVAS"][onclick^="editProducto"]');
    assert.strictEqual(await page.inputValue('#p-kit'), 'HSJ-20121 x1\nHP-Q035B1 x1');
    assert.strictEqual(await page.inputValue('#p-stock-dep'), '9');
    assert.strictEqual(await page.$eval('#p-stock-dep', el => el.readOnly), true);
    assert.match(await page.textContent('#p-stock-hint'), /Kit: 9 completos/);

    await page.click('#modal-producto .btn-primary');
    await page.waitForFunction(() => !document.getElementById('modal-producto').classList.contains('open'));
    const put = estado.productosPut.at(-1);
    assert.strictEqual(put.sku, 'KIT-ESP-LEVAS');
    assert.deepStrictEqual(put.componentes, [{ sku: 'HSJ-20121', cantidad: 1 }, { sku: 'HP-Q035B1', cantidad: 1 }]);
  });

  await t.test('guardar un producto común no toca la tabla de kits', async () => {
    await page.click('button[data-sku="HP-Q035B1"][onclick^="editProducto"]');
    assert.strictEqual(await page.inputValue('#p-kit'), '');
    assert.strictEqual(await page.$eval('#p-stock-dep', el => el.readOnly), false);
    await page.click('#modal-producto .btn-primary');
    await page.waitForFunction(() => !document.getElementById('modal-producto').classList.contains('open'));
    const put = estado.productosPut.at(-1);
    assert.strictEqual(put.sku, 'HP-Q035B1');
    assert.strictEqual(put.componentes, undefined);
  });

  await t.test('despachar un kit pide escanear cada pieza', async () => {
    await page.click(`.nav-item[onclick="goPage('despacho')"]`);
    await escanear(page, '41110000900');
    await page.waitForSelector('#desp-paquete .desp-item');
    const panel = await page.textContent('#desp-paquete');
    assert.match(panel, /HSJ-20121/);
    assert.match(panel, /HP-Q035B1/);
    assert.doesNotMatch(panel, /KIT-ESP-LEVAS/);

    await escanear(page, 'HSJ-20121');
    await escanear(page, 'HP-Q035B1');
    await page.waitForFunction(() => /Paquete controlado/.test(document.getElementById('desp-mensaje').textContent));
    const put = estado.enviosPut.find(p => p.id === 'E_MELI_900');
    assert.deepStrictEqual(put.control.items, [
      { sku: 'HSJ-20121', esperado: 1, escaneado: 1, manual: 0 },
      { sku: 'HP-Q035B1', esperado: 1, escaneado: 1, manual: 0 },
    ]);
  });

  await t.test('sin errores de consola', async () => {
    assert.deepStrictEqual(erroresReales(crm.errores), []);
    assert.deepStrictEqual(crm.alertas, []);
  });
});
