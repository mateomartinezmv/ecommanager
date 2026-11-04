// ✅ Control de despacho → 🖨️ etiquetas de MELI: elegir con casillas qué envíos van al PDF,
// los atajos Todas / Las que faltan imprimir / Ninguna, y bajar un solo PDF para la térmica.
//
// Lo que se protege: que sólo los envíos de MELI pendientes tengan casilla; que "las que
// faltan" se decida con lo que dice MELI (también cuenta lo impreso desde su panel) y deje
// afuera lo que MELI no entrega; que el PDF pida exactamente lo elegido; que lo recién impreso
// no vuelva a aparecer como faltante; los errores de MELI a la vista; y que el lector siga
// escaneando aunque el cursor haya quedado en una casilla.

const { test } = require('node:test');
const assert = require('node:assert');
const { HOY, abrirCRM, erroresReales } = require('./helpers');

function estadoEtiquetas() {
  const venta = (id, extra) => ({ id, canal: 'meli', fecha: HOY, sku: 'SKU1', producto: 'Slider', cantidad: 1,
    precio_unit: 1000, comision: 150, total: 1000, estado: 'pagada', metodo_pago: 'mercadopago', created_at: HOY, ...extra });
  const envio = (id, ventaId, comprador, extra) => ({ id, venta_id: ventaId, comprador, producto: 'Slider',
    transportista: 'mercado_envios', estado: 'pendiente', created_at: HOY, ...extra });
  return {
    productos: [{ sku: 'SKU1', nombre: 'Slider', tipo: 'nuevo', stock_dep: 10, stock_meli: 10, costo: 400,
      precio: 1000, alerta_min: 1, created_at: HOY }],
    ventas: [
      venta('V_A', { orden_meli: '2000000000000011', comprador: 'Ana' }),
      venta('V_B', { orden_meli: '2000000000000012', comprador: 'Beto' }),
      venta('V_C', { orden_meli: '2000000000000013', comprador: 'Caro' }),
      venta('V_D', { orden_meli: '2000000000000014', comprador: 'Dani' }),
      venta('V_M', { canal: 'mostrador', comprador: null, cliente: 'Mostrador Juan' }),
    ],
    envios: [
      envio('E_MELI_A', 'V_A', 'Ana', { orden: '2000000000000011', tracking: 'MEL44000000001FMDOF01' }),
      envio('E_MELI_B', 'V_B', 'Beto', { orden: '2000000000000012', transportista: 'enviosuy', meli_shipment_id: '44000000002' }),
      envio('E_MELI_C', 'V_C', 'Caro', { orden: '2000000000000013' }),
      envio('E_MELI_D', 'V_D', 'Dani', { orden: '2000000000000014', estado: 'en_camino' }),
      envio('E-M', 'V_M', 'Mostrador Juan', { transportista: 'ues' }),
    ],
    // Lo que dice MELI: la de Ana ya se imprimió desde su panel; la de Caro todavía no la da.
    etiquetasMeliEstado: {
      E_MELI_A: { impresa: true, imprimible: true, status: 'ready_to_ship', substatus: 'printed' },
      E_MELI_B: { impresa: false, imprimible: true, status: 'ready_to_ship', substatus: 'ready_to_print' },
      E_MELI_C: { impresa: false, imprimible: false, status: 'pending', substatus: 'buffered' },
    },
  };
}

const casillas = page => page.$$eval('#desp-lista .desp-check', cs => cs.map(c => ({ id: c.dataset.id, elegida: c.checked, bloqueada: c.disabled })));
const elegidas = async page => (await casillas(page)).filter(c => c.elegida).map(c => c.id).sort();
const fila = (page, id) => page.textContent(`#desp-lista .desp-fila[data-id="${id}"]`);
const botonImprimir = page => page.textContent('#desp-imprimir');
const aviso = page => page.textContent('#desp-etq-aviso');

async function imprimir(page) {
  const [ventana] = await Promise.all([page.waitForEvent('popup'), page.click('#desp-imprimir')]);
  await page.waitForFunction(() => !/Bajando/.test(document.getElementById('desp-imprimir').textContent));
  return ventana;
}

test('etiquetas de MELI desde el control de despacho', async (t) => {
  const crm = await abrirCRM({ estado: estadoEtiquetas() });
  t.after(() => crm.cerrar());
  const { page, estado } = crm;
  await page.click(`.nav-item[onclick="goPage('despacho')"]`);
  await page.waitForFunction(() => /Impresa/.test(document.getElementById('desp-lista').textContent));

  await t.test('sólo los envíos de MELI pendientes tienen casilla, y cada uno dice si falta', async () => {
    assert.deepStrictEqual(await casillas(page), [
      { id: 'E_MELI_A', elegida: false, bloqueada: false },
      { id: 'E_MELI_B', elegida: false, bloqueada: false },
      { id: 'E_MELI_C', elegida: false, bloqueada: true },
      // Mostrador sin dirección: tiene etiqueta del CRM, pero sin dirección no sirve.
      { id: 'E-M', elegida: false, bloqueada: true },
    ]);
    assert.match(await fila(page, 'E_MELI_A'), /🖨️ Impresa/);
    assert.match(await fila(page, 'E_MELI_B'), /🖨️ Sin imprimir/);
    assert.match(await fila(page, 'E_MELI_C'), /🖨️ No disponible/);
    assert.doesNotMatch(await fila(page, 'E-M'), /🖨️/, 'mostrador usa la etiqueta del CRM, no la de MELI');
    assert.match(await fila(page, 'E-M'), /🏷️ Falta dirección/);
    assert.match(await botonImprimir(page), /Imprimir \(0\)/);
    assert.ok(await page.isDisabled('#desp-imprimir'));
  });

  await t.test('"las que faltan imprimir" elige sólo esas', async () => {
    await page.click('#desp-lista button:text-is("Las que faltan imprimir")');
    assert.deepStrictEqual(await elegidas(page), ['E_MELI_B']);
    assert.match(await botonImprimir(page), /Imprimir \(1\)/);
  });

  await t.test('se suma una a mano y el PDF trae exactamente las elegidas', async () => {
    await page.check('#desp-lista .desp-check[data-id="E_MELI_A"]');
    assert.match(await botonImprimir(page), /Imprimir \(2\)/);
    await imprimir(page);
    assert.deepStrictEqual(estado.etiquetasPedidas.at(-1).sort(), ['E_MELI_A', 'E_MELI_B']);
    assert.match(await aviso(page), /2 etiqueta\(s\) en el PDF/);
    assert.deepStrictEqual(await elegidas(page), [], 'después de imprimir se limpia la selección');
    assert.match(await fila(page, 'E_MELI_B'), /🖨️ Impresa/, 'lo recién impreso ya figura impreso');
  });

  await t.test('ya no falta ninguna', async () => {
    await page.click('#desp-lista button:text-is("Las que faltan imprimir")');
    assert.deepStrictEqual(await elegidas(page), []);
    assert.match(await aviso(page), /No falta imprimir ninguna/);
  });

  await t.test('"todas" deja afuera la que MELI no entrega, y "ninguna" limpia', async () => {
    await page.click('#desp-lista button:text-is("Todas")');
    assert.deepStrictEqual(await elegidas(page), ['E_MELI_A', 'E_MELI_B']);
    await page.click('#desp-lista button:text-is("Ninguna")');
    assert.deepStrictEqual(await elegidas(page), []);
  });

  await t.test('si MELI no las da, se ve por qué y la selección queda', async () => {
    estado.etiquetasFalla = 'MELI no entregó las etiquetas: shipment not ready to print';
    await page.click('#desp-lista button:text-is("Todas")');
    await imprimir(page);
    assert.match(await aviso(page), /❌ MELI no entregó las etiquetas: shipment not ready to print/);
    assert.deepStrictEqual(await elegidas(page), ['E_MELI_A', 'E_MELI_B']);
    estado.etiquetasFalla = null;
  });

  await t.test('un envío sin shipment de MELI queda afuera del PDF y se avisa', async () => {
    estado.etiquetasSinShipment = ['E_MELI_A'];
    await imprimir(page);
    assert.match(await aviso(page), /1 etiqueta\(s\) en el PDF/);
    assert.match(await aviso(page), /Quedaron afuera 1 sin envío de MELI: Ana/);
    estado.etiquetasSinShipment = [];
  });

  await t.test('con el cursor en una casilla, el lector sigue escaneando', async () => {
    await page.click('#desp-lista .desp-check[data-id="E_MELI_B"]');
    await page.keyboard.type('44000000002');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Beto/.test(document.getElementById('desp-paquete').textContent));
  });

  await t.test('no hubo errores', () => {
    const reales = erroresReales(crm.errores, [/502/]);
    assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
    assert.deepStrictEqual(crm.alertas, []);
  });
});

test('si MELI no dice qué está impreso, se eligen a mano igual', async (t) => {
  const crm = await abrirCRM({ estado: { ...estadoEtiquetas(), etiquetasEstadoFalla: 'timeout' } });
  t.after(() => crm.cerrar());
  const { page, estado } = crm;
  await page.click(`.nav-item[onclick="goPage('despacho')"]`);
  await page.waitForSelector('#desp-etq-aviso');
  assert.match(await aviso(page), /No se pudo consultar a MELI qué etiquetas faltan/);
  assert.ok((await casillas(page)).filter(c => c.id.startsWith('E_MELI_')).every(c => !c.bloqueada), 'sin saber, no se bloquea ninguna de MELI');

  await page.click('#desp-lista button:text-is("Las que faltan imprimir")');
  await page.waitForFunction(() => /MELI no respondió/.test(document.getElementById('desp-etq-aviso')?.textContent || ''));
  assert.deepStrictEqual(await elegidas(page), []);

  await page.check('#desp-lista .desp-check[data-id="E_MELI_C"]');
  await imprimir(page);
  assert.deepStrictEqual(estado.etiquetasPedidas.at(-1), ['E_MELI_C']);
  const reales = erroresReales(crm.errores, [/500/]);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});
