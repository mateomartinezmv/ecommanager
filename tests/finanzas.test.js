// Gastos e ingresos extra: carga, categorías, gráficos y su efecto en la rentabilidad.
//
// Los subtests comparten una misma página y se apoyan en el estado que dejó el anterior
// (se cargan movimientos y después se verifica cómo cambian los totales), así que el orden
// importa. El runner de Node los corre en secuencia dentro del archivo.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, erroresReales, leerTarjetas } = require('./helpers');

let crm;
const valor = (tarjetas, etiqueta) => (tarjetas.find(t => t.etiqueta.startsWith(etiqueta)) || {}).valor;
// '$-13.090' → -13090
const aNumero = texto => parseFloat(String(texto).replace(/[^\d,-]/g, '').replace(',', '.'));

before(async () => {
  crm = await abrirCRM();
  await crm.page.click(`.nav-item[onclick="goPage('finanzas')"]`);
  await crm.page.waitForSelector('#finanzas-tbody tr');
});

after(async () => { if (crm) await crm.cerrar(); });

test('los totales del período salen de los movimientos cargados', async () => {
  const tarjetas = await leerTarjetas(crm.page, '#finanzas-stats');
  assert.strictEqual(aNumero(valor(tarjetas, 'Otros gastos')), 1820, 'gastos = 1500 + 320');
  assert.strictEqual(aNumero(valor(tarjetas, 'Otros ingresos')), 840);
  assert.strictEqual(aNumero(valor(tarjetas, 'Efecto neto')), -980, 'neto = 840 − 1820');
  assert.strictEqual(aNumero(valor(tarjetas, 'Movimientos cargados')), 3);
});

test('los gráficos circulares dibujan una porción por categoría', async () => {
  const gastos = await crm.page.$$eval('#finanzas-donut-gastos svg path, #finanzas-donut-gastos svg circle', e => e.length);
  const ingresos = await crm.page.$$eval('#finanzas-donut-ingresos svg path, #finanzas-donut-ingresos svg circle', e => e.length);
  assert.strictEqual(gastos, 2, 'dos categorías de gasto → dos arcos');
  // Con una sola categoría el arco de 360° degenera en un punto: se dibuja como anillo.
  assert.strictEqual(ingresos, 1, 'una sola categoría de ingreso → anillo completo');

  const leyenda = (await crm.page.textContent('#finanzas-donut-gastos')).replace(/\s+/g, ' ');
  assert.match(leyenda, /Packaging/);
  assert.match(leyenda, /82\.4%/, '1500 sobre 1820 — ' + leyenda.slice(0, 160));
});

test('las pestañas filtran por tipo de movimiento', async () => {
  const filas = () => crm.page.$$eval('#finanzas-tbody tr', r => r.length);
  await crm.page.click('#tab-fin-ingreso');
  assert.strictEqual(await filas(), 1);
  await crm.page.click('#tab-fin-gasto');
  assert.strictEqual(await filas(), 2);
  await crm.page.click('#tab-fin-all');
  assert.strictEqual(await filas(), 3);
});

test('un gasto en USD se guarda convertido con la cotización del día', async () => {
  await crm.page.click(`button[onclick="openModalMovimiento(null,'gasto')"]`);
  await crm.page.waitForSelector('#modal-movimiento.open');
  await crm.page.selectOption('#mov-categoria', 'packaging');
  await crm.page.fill('#mov-concepto', 'Cajas importadas');
  await crm.page.fill('#mov-monto', '100');
  await crm.page.selectOption('#mov-moneda', 'USD');
  assert.ok(await crm.page.isVisible('#mov-cotiz-aviso'), 'avisa a qué cotización se convierte');
  await crm.page.click(`#modal-movimiento button[onclick="saveMovimiento()"]`);
  await crm.page.waitForFunction(() => document.querySelectorAll('#finanzas-tbody tr').length === 4);

  const guardado = crm.estado.movimientos.find(m => m.concepto === 'Cajas importadas');
  assert.strictEqual(guardado.monto_uyu, 4200, '100 USD × 42');
  assert.strictEqual(guardado.cotizacion, 42, 'la cotización queda junto al movimiento');

  const tarjetas = await leerTarjetas(crm.page, '#finanzas-stats');
  assert.strictEqual(aNumero(valor(tarjetas, 'Otros gastos')), 6020, '1820 + 4200');
});

test('el check del Literal E sólo aparece en los ingresos', async () => {
  await crm.page.click(`button[onclick="openModalMovimiento(null,'ingreso')"]`);
  await crm.page.waitForSelector('#modal-movimiento.open');
  assert.ok(await crm.page.isVisible('#mov-facturacion-wrap'));
  await crm.page.selectOption('#mov-tipo', 'gasto');
  assert.ok(!(await crm.page.isVisible('#mov-facturacion-wrap')), 'un gasto no puede sumar al tope');

  await crm.page.selectOption('#mov-tipo', 'ingreso');
  await crm.page.selectOption('#mov-categoria', 'rendimientos');
  await crm.page.fill('#mov-concepto', 'Reintegro facturado');
  await crm.page.fill('#mov-monto', '5000');
  await crm.page.check('#mov-cuenta-facturacion');
  await crm.page.click(`#modal-movimiento button[onclick="saveMovimiento()"]`);
  await crm.page.waitForFunction(() => document.querySelectorAll('#finanzas-tbody tr').length === 5);

  assert.strictEqual(crm.estado.movimientos.find(m => m.concepto === 'Reintegro facturado').cuenta_facturacion, true);
});

test('Reportes descuenta los otros gastos y suma los otros ingresos', async () => {
  const calculado = await crm.page.evaluate(() => {
    document.getElementById('reporte-periodo').value = '30';
    renderReportes();
    const { desde, hasta } = getReporteFiltro();
    return { movs: totalesMovimientos(movimientosEnRango(desde, hasta)), fijos: getCostosFijosEnUYU() };
  });
  assert.strictEqual(calculado.movs.gastos, 6020);
  assert.strictEqual(calculado.movs.ingresos, 5840, '840 + 5000');

  const tarjetas = await leerTarjetas(crm.page, '#reporte-stats');
  assert.ok(valor(tarjetas, 'Otros gastos'), 'hay tarjeta de otros gastos');
  assert.ok(valor(tarjetas, 'Otros ingresos'), 'hay tarjeta de otros ingresos');

  // ventas 2000 − comisión 300 − costo producto 800 − envíos 0 − fijos − 6020 + 5840
  const esperado = Math.round(2000 - 300 - 800 - calculado.fijos - 6020 + 5840);
  assert.strictEqual(aNumero(valor(tarjetas, 'Ganancia neta')), esperado);

  // El margen se mide contra los ingresos por ventas, no contra ventas + otros ingresos.
  const margen = parseFloat(valor(tarjetas, 'Margen neto'));
  assert.strictEqual(margen, parseFloat(((esperado / 2000) * 100).toFixed(1)));
});

test('sólo el ingreso marcado como facturado computa contra el tope del Literal E', async () => {
  const f = await crm.page.evaluate(() => calcFacturacion());
  assert.strictEqual(f.otrosIngresosFacturados, 5000, 'los rendimientos sin marcar no suman');
  assert.strictEqual(f.facturadoAnio, 2000 + 5000, 'venta MELI + ingreso marcado');
  assert.ok(f.desglose.some(d => d.canal === 'otros' && d.total === 5000), 'aparece en "Qué entra y qué no"');
});

test('no se puede borrar una categoría que tiene movimientos', async () => {
  crm.alertas.length = 0;
  await crm.page.click(`button[onclick="openModalCategoriaMov()"]`);
  await crm.page.waitForSelector('#modal-categoria-mov.open');
  await crm.page.click(`button[onclick="deleteCategoriaMov('packaging')"]`);
  await crm.page.waitForFunction(() => true);
  await crm.page.waitForTimeout(300);

  assert.ok(crm.alertas.some(m => /movimientos cargados/.test(m)), 'explica por qué no se borra — ' + JSON.stringify(crm.alertas));
  assert.ok(crm.estado.categorias.some(c => c.id === 'packaging'), 'la categoría sigue existiendo');
});

test('una categoría nueva aparece sólo en el formulario que corresponde', async () => {
  await crm.page.fill('#cat-mov-nombre', 'Comisiones bancarias');
  await crm.page.selectOption('#cat-mov-tipo', 'gasto');
  await crm.page.click('#cat-mov-save-btn');
  await crm.page.waitForFunction(() => db.movCategorias.some(c => c.nombre === 'Comisiones bancarias'));
  await crm.page.click(`#modal-categoria-mov button[onclick="closeModal('modal-categoria-mov')"]`);

  const opciones = tipo => crm.page.evaluate(t => {
    openModalMovimiento(null, t);
    const os = [...document.querySelectorAll('#mov-categoria option')].map(o => o.textContent);
    closeModal('modal-movimiento');
    return os;
  }, tipo);

  assert.ok((await opciones('gasto')).includes('Comisiones bancarias'));
  const deIngreso = await opciones('ingreso');
  assert.ok(!deIngreso.includes('Comisiones bancarias'), 'una categoría "sólo gastos" no sale en ingresos');
  assert.ok(!deIngreso.includes('Packaging'));
  assert.ok(deIngreso.includes('Envíos'), 'una categoría "ambos" sale de los dos lados');
});

test('el PDF de Reportes se genera e incluye los movimientos', async () => {
  // El CDN de jsPDF no está disponible offline: se stubea para verificar que la función
  // corre entera y qué texto manda al documento. Antes rompía con un ReferenceError.
  const pdf = await crm.page.evaluate(() => {
    const textos = [];
    const doc = new Proxy({}, {
      get(_, prop) {
        if (prop === 'lastAutoTable') return { finalY: 100 };
        if (prop === 'internal') return { pageSize: { getWidth: () => 297, getHeight: () => 210 } };
        return (...args) => {
          if (prop === 'text') textos.push(String(args[0]));
          if (prop === 'autoTable') textos.push(JSON.stringify(args[0].head) + JSON.stringify(args[0].body));
          if (prop === 'splitTextToSize') return [String(args[0])];
          if (prop === 'getNumberOfPages') return 1;
          return undefined;
        };
      },
    });
    window.jspdf = { jsPDF: function () { return doc; } };
    try { exportReportePDF(); return { ok: true, texto: textos.join('\n') }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  assert.ok(pdf.ok, 'exportReportePDF() — ' + pdf.error);
  assert.match(pdf.texto, /Per.odo: .ltimos 30 d.as/, 'el período sale del filtro, no de una variable inexistente');
  assert.match(pdf.texto, /Otros gastos/);
  assert.match(pdf.texto, /Otros ingresos/);
});

test('borrar un movimiento actualiza la tabla', async () => {
  await crm.page.click(`.nav-item[onclick="goPage('finanzas')"]`);
  await crm.page.waitForSelector('#finanzas-tbody tr');
  const antes = await crm.page.$$eval('#finanzas-tbody tr', r => r.length);
  await crm.page.click(`button[onclick="deleteMovimiento('MOV-1')"]`);
  await crm.page.waitForFunction(n => document.querySelectorAll('#finanzas-tbody tr').length === n - 1, antes);
  assert.ok(!crm.estado.movimientos.some(m => m.id === 'MOV-1'));
});

test('la pantalla no dejó errores en consola', () => {
  // El 409 lo provoca a propósito el test de borrar una categoría en uso.
  const reales = erroresReales(crm.errores, [/409 \(Conflict\)/]);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});
