// ✅ Control de despacho: quien arma escanea la etiqueta de MELI del paquete y después la
// etiqueta SKU de cada producto que mete en la caja.
//
// Lo que se protege: que la etiqueta encuentre el envío (Mercado Envíos por el número que
// ya está en el tracking; Flex preguntándole al servidor la primera vez, con el QR leído
// con el teclado cambiado), que un producto que no va, una unidad de más o un código
// cualquiera frenen con error y queden anotados, que un par de sliders pida dos escaneos,
// que una venta cancelada no se despache, que lo marcado a mano quede registrado, que el
// resultado se guarde en el envío y se vea en Envíos, y que sin la migración el control
// funcione igual y avise qué falta.

const { test } = require('node:test');
const assert = require('node:assert');
const { HOY, abrirCRM, erroresReales } = require('./helpers');

function estadoDespacho() {
  const venta = (id, extra) => ({ id, canal: 'meli', fecha: HOY, precio_unit: 1000, comision: 150, total: 1000,
    cantidad: 1, estado: 'pagada', metodo_pago: 'mercadopago', created_at: HOY, ...extra });
  return {
    productos: [
      { sku: 'ALERONFINOSNK', nombre: 'Espejos Moto Tipo Alerón Finos - Negro', tipo: 'nuevo', stock_dep: 5,
        stock_meli: 5, costo: 300, precio: 1000, alerta_min: 1, meli_ids: ['MLU1327525424'], created_at: HOY },
      { sku: 'SLIDER-R6', nombre: 'Slider R6 - Rojo', tipo: 'nuevo', stock_dep: 8, stock_meli: 4, costo: 500,
        precio: 1500, alerta_min: 1, unidades_por_venta: 2, created_at: HOY },
      { sku: 'ESPEJO-RED', nombre: 'Espejo redondo', tipo: 'nuevo', stock_dep: 3, stock_meli: 3, costo: 200,
        precio: 700, alerta_min: 1, created_at: HOY },
    ],
    ventas: [
      // Mercado Envíos, la de la etiqueta de ejemplo.
      venta('V_MELI_2000019306034118_MLU1327525424', { orden_meli: '2000019306034118', pack_id: '2000015832269441',
        sku: 'ALERONFINOSNK', producto: 'Espejos Moto Tipo Alerón Finos', meli_item_id: 'MLU1327525424', comprador: 'Diego de los Santos' }),
      // Carrito Flex: dos órdenes atadas por el pack, un solo envío. Los sliders van de a par.
      venta('V_F1', { orden_meli: '2000000000000001', pack_id: '2000099', sku: 'SLIDER-R6', producto: 'Slider R6', comprador: 'Ana Gómez' }),
      venta('V_F2', { orden_meli: '2000000000000002', pack_id: '2000099', sku: 'ALERONFINOSNK', producto: 'Espejos Alerón', comprador: 'Ana Gómez' }),
      // Venta cancelada que todavía tiene su envío pendiente.
      venta('V_C', { orden_meli: '2000000000000077', sku: 'ESPEJO-RED', producto: 'Espejo redondo', comprador: 'Pedro Ruiz', estado: 'cancelada' }),
    ],
    envios: [
      { id: 'E_MELI_2000015832269441', venta_id: 'V_MELI_2000019306034118_MLU1327525424', orden: '2000019306034118',
        pack_id: '2000015832269441', comprador: 'Diego de los Santos', producto: 'Espejos Moto Tipo Alerón Finos',
        transportista: 'mercado_envios', tracking: 'MEL48412750656FMDOF01', estado: 'pendiente',
        direccion: 'Jose A. Possolo 646, Melo', created_at: HOY },
      { id: 'E_MELI_2000099', venta_id: 'V_F1', orden: '2000000000000001', pack_id: '2000099', comprador: 'Ana Gómez',
        producto: 'Slider R6 x1 + Espejos Alerón x1', transportista: 'enviosuy', tracking: 'RLX6W3ZYEVLA7AV74YRRYZGI5I',
        estado: 'pendiente', direccion: 'Bvar. Artigas 1500', created_at: HOY },
      { id: 'E_MELI_C', venta_id: 'V_C', orden: '2000000000000077', comprador: 'Pedro Ruiz', producto: 'Espejo redondo',
        transportista: 'mercado_envios', estado: 'pendiente', created_at: HOY },
    ],
    // El shipment del QR de Flex, que sólo conoce MELI.
    etiquetasMeli: { '44000000001': 'E_MELI_2000099' },
    fotosPublicaciones: { MLU1327525424: 'https://http2.mlstatic.com/D_aleron.jpg' },
  };
}

async function escanear(page, codigo) {
  await page.keyboard.type(codigo);
  await page.keyboard.press('Enter');
}
const mensaje = page => page.textContent('#desp-mensaje');
const claseMensaje = page => page.getAttribute('#desp-mensaje', 'class');

test('control de despacho con el lector', async (t) => {
  const crm = await abrirCRM({ estado: estadoDespacho() });
  t.after(() => crm.cerrar());
  const { page, estado } = crm;
  await page.click(`.nav-item[onclick="goPage('despacho')"]`);

  await t.test('arranca con los pendientes y el cursor en el campo de escaneo', async () => {
    assert.match(await page.textContent('#desp-contador'), /0 de 3/);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'desp-input');
    assert.strictEqual((await page.$$('#desp-lista button[data-id]')).length, 3);
  });

  await t.test('un producto antes de la etiqueta pide primero la etiqueta', async () => {
    await escanear(page, 'ALERONFINOSNK');
    assert.match(await mensaje(page), /Primero escaneá la etiqueta de MELI/);
  });

  await t.test('Mercado Envíos: la etiqueta abre el paquete por el número del tracking', async () => {
    await escanear(page, '48412750656');
    await page.waitForSelector('#desp-paquete .desp-item');
    const panel = await page.textContent('#desp-paquete');
    assert.match(panel, /Diego de los Santos/);
    assert.match(panel, /ALERONFINOSNK/);
    assert.match(panel, /0\s*\/ 1/);
    // La variante va resaltada aparte y la foto viene de la publicación.
    assert.strictEqual(await page.textContent('#desp-paquete .desp-variante'), 'Negro');
    await page.waitForSelector('#desp-paquete .desp-foto img');
    assert.strictEqual(await page.getAttribute('#desp-paquete .desp-foto img', 'src'), 'https://http2.mlstatic.com/D_aleron.jpg');
    assert.deepStrictEqual(estado.buscados || [], [], 'no hizo falta preguntarle al servidor');
  });

  await t.test('un producto que no va frena con error', async () => {
    await escanear(page, 'ESPEJO-RED');
    assert.match(await mensaje(page), /ESPEJO-RED NO va en este paquete/);
    assert.match(await claseMensaje(page), /desp-msg-error/);
  });

  await t.test('el correcto, aunque llegue en minúsculas, cierra el paquete y lo guarda', async () => {
    await escanear(page, 'aleronfinosnk');
    await page.waitForFunction(() => /Paquete controlado/.test(document.getElementById('desp-mensaje').textContent));
    const put = estado.enviosPut.find(p => p.id === 'E_MELI_2000015832269441');
    assert.ok(put.controladoAt, 'se guardó la hora del control');
    assert.deepStrictEqual(put.control.items, [{ sku: 'ALERONFINOSNK', esperado: 1, escaneado: 1, manual: 0 }]);
    assert.deepStrictEqual(put.control.errores.map(e => [e.tipo, e.sku]), [['otro_producto', 'ESPEJO-RED']]);
    assert.match(await page.textContent('#desp-contador'), /1 de 3/);
  });

  await t.test('Flex: el QR leído con el teclado cambiado se resuelve contra MELI', async () => {
    // {"id":"44000000001","t":"lm"} con el lector en inglés y la PC en español.
    await escanear(page, 'Ñ¨id¨Ñ¨44000000001¨,¨t¨Ñ¨lm¨*');
    await page.waitForFunction(() => /Ana Gómez/.test(document.getElementById('desp-paquete').textContent));
    assert.deepStrictEqual(estado.buscados, ['Ñ¨id¨Ñ¨44000000001¨,¨t¨Ñ¨lm¨*']);
    const panel = await page.textContent('#desp-paquete');
    assert.match(panel, /SLIDER-R6/);
    assert.match(panel, /ALERONFINOSNK/);
    assert.match(panel, /Se vende de a par/);
  });

  await t.test('el par pide dos escaneos y el tercero sobra', async () => {
    await escanear(page, 'SLIDER-R6');
    assert.match(await mensaje(page), /Faltan 1 más/);
    await escanear(page, 'SLIDER/R6');   // el guion cambiado por el idioma del teclado
    assert.match(await mensaje(page), /Listo este producto/);
    await escanear(page, 'SLIDER-R6');
    assert.match(await mensaje(page), /Sobra un SLIDER-R6/);
  });

  await t.test('otra etiqueta o un código cualquiera con el paquete a medias', async () => {
    await escanear(page, '48412750656');
    assert.match(await mensaje(page), /Primero terminá este paquete/);
    await escanear(page, 'XYZ');
    assert.match(await mensaje(page), /Código no reconocido/);
  });

  await t.test('completo: guarda los errores frenados', async () => {
    await escanear(page, 'ALERONFINOSNK');
    await page.waitForFunction(() => /Paquete controlado/.test(document.getElementById('desp-mensaje').textContent));
    assert.match(await mensaje(page), /Se frenaron 2 escaneo/);
    const put = estado.enviosPut.find(p => p.id === 'E_MELI_2000099');
    assert.deepStrictEqual(put.control.items, [
      { sku: 'SLIDER-R6', esperado: 2, escaneado: 2, manual: 0 },
      { sku: 'ALERONFINOSNK', esperado: 1, escaneado: 1, manual: 0 },
    ]);
    assert.deepStrictEqual(put.control.errores.map(e => e.tipo), ['sobra', 'desconocido']);
  });

  await t.test('una venta cancelada no se despacha', async () => {
    await page.click('#desp-lista button[data-id="E_MELI_C"]');
    assert.match(await mensaje(page), /cancelada: NO se despacha/);
    assert.strictEqual(await page.$('#desp-paquete .desp-item'), null);
  });

  await t.test('volver a controlar avisa, y la etiqueta que no lee queda como "a mano"', async () => {
    await escanear(page, '48412750656');
    assert.match(await mensaje(page), /Ya se había controlado/);
    await page.click('#desp-paquete button[data-sku="ALERONFINOSNK"]');
    await page.waitForFunction(() => /Paquete controlado/.test(document.getElementById('desp-mensaje').textContent));
    const puts = estado.enviosPut.filter(p => p.id === 'E_MELI_2000015832269441');
    assert.deepStrictEqual(puts.at(-1).control.items, [{ sku: 'ALERONFINOSNK', esperado: 1, escaneado: 0, manual: 1 }]);
    // El control anterior queda en el historial, con el error que había frenado.
    assert.deepStrictEqual(puts.at(-1).control.historial.map(h => h.errores.length), [1]);
    assert.strictEqual(crm.alertas.length, 1);
    assert.match(crm.alertas[0], /sin escanear/);
  });

  await t.test('Envíos muestra qué pasó por el lector', async () => {
    await page.click(`.nav-item[onclick="goPage('envios')"]`);
    const resumen = await page.textContent('#envios-control-resumen');
    assert.match(resumen, /2 de 3 pendientes controlados/);
    assert.match(resumen, /1 sin controlar/);
    assert.match(resumen, /3 escaneo\(s\) equivocado\(s\) frenado\(s\) hoy/);
    const fila = n => page.textContent(`#envios-tbody tr:has-text("${n}")`);
    assert.match(await fila('Ana Gómez'), /✅ Controlado · 2 ✋/);
    assert.match(await fila('Diego de los Santos'), /✅ Controlado · 1 a mano · 1 ✋/);
    assert.match(await fila('Pedro Ruiz'), /Sin controlar/);
  });

  await t.test('no hubo errores', () => {
    const reales = erroresReales(crm.errores);
    assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
  });
});

test('sin la migración el control funciona igual y avisa', async (t) => {
  const crm = await abrirCRM({ estado: { ...estadoDespacho(), sinControl: true } });
  t.after(() => crm.cerrar());
  const { page } = crm;
  await page.click(`.nav-item[onclick="goPage('despacho')"]`);
  await escanear(page, '48412750656');
  await page.waitForSelector('#desp-paquete .desp-item');
  await escanear(page, 'ALERONFINOSNK');
  await page.waitForFunction(() => /Paquete correcto/.test(document.getElementById('desp-mensaje').textContent));
  assert.ok(await page.isVisible('#desp-aviso'));
  assert.match(await page.textContent('#desp-aviso'), /20261103000000_add_control_envios\.sql/);
  // El paquete queda cerrado: se puede seguir con el próximo.
  assert.strictEqual(await page.$('#desp-paquete .desp-item'), null);
  const reales = erroresReales(crm.errores, [/503/]);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});
