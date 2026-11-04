// Ventas → 🧾 Excel Gesta y 📎 Subir facturas a MELI, manejadas como las usa el usuario: qué
// ventas ofrece, el Excel que baja (leído de vuelta con SheetJS), marcar facturadas, y subir
// el PDF del eTicket reconociendo la venta por la adenda.
//
// Sin red, los CDN no cargan: SheetJS se sirve desde node_modules y pdf.js se reemplaza por
// uno falso que devuelve el texto guardado adentro del PDF de prueba.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { HOY, abrirCRM, erroresReales, estadoDemo } = require('./helpers');

let crm;

function estado() {
  const e = estadoDemo();
  e.productos.push(
    { sku: 'HP-Q0211', nombre: 'Guardamanos ABS Negro', tipo: 'nuevo', stock_dep: 5, stock_meli: 5, stock_shopify: 0,
      costo: 200, precio: 690, alerta_min: 1, discontinuado: false, codigo_gesta: 17, created_at: HOY },
    { sku: 'EXT-1', nombre: 'Extensor espejo', tipo: 'nuevo', stock_dep: 5, stock_meli: 5, stock_shopify: 0,
      costo: 20, precio: 100, alerta_min: 1, discontinuado: false, codigo_gesta: null, created_at: HOY },
  );
  e.ventas.push(
    { id: 'V_MELI_2000019328655326_X', canal: 'meli', fecha: HOY, orden_meli: '2000019328655326', pack_id: '2000015853536563',
      comprador: 'GONZALOGAL', sku: 'HP-Q0211', producto: 'Guardamanos Protector Puños Moto Enduro Cross ABS - Negro',
      cantidad: 1, precio_unit: 635.84, comision: 120.38, total: 635.84, estado: 'pagada', facturada: null, created_at: HOY + 'T10:00:00Z' },
    { id: 'V_MELI_2000018888888888_Y', canal: 'meli', fecha: HOY, orden_meli: '2000018888888888', pack_id: null,
      comprador: 'OTRO', sku: 'EXT-1', producto: 'Extensor espejo', cantidad: 1, precio_unit: 100, comision: 10, total: 100,
      estado: 'pagada', facturada: null, created_at: HOY + 'T09:00:00Z' },
  );
  return e;
}

before(async () => {
  crm = await abrirCRM({ estado: estado() });
  await crm.page.route('**/xlsx.full.min.js', r => r.fulfill({
    contentType: 'application/javascript',
    body: fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')),
  }));
  await crm.page.click(`.nav-item[onclick="goPage('ventas')"]`);
  await crm.page.waitForSelector('#ventas-tbody tr');
});

after(async () => { if (crm) await crm.cerrar(); });

const celdaDeVenta = (orden) => crm.page.$eval('#ventas-tbody', (tb, orden) => {
  const fila = [...tb.querySelectorAll('tr')].find(tr => tr.textContent.includes(orden));
  return fila ? fila.children[7].textContent.trim() : null;
}, orden);

test('la venta MELI nueva figura sin facturar', async () => {
  assert.match(await celdaDeVenta('2000019328655326'), /Sin facturar/);
});

test('el Excel Gesta ofrece la venta con su código y deja afuera la del producto sin código', async () => {
  await crm.page.click('#btn-gesta');
  await crm.page.waitForSelector('#modal-gesta.open');
  const filas = await crm.page.$$eval('#gesta-tbody tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  assert.strictEqual(filas.length, 1);
  assert.match(filas[0], /2000015853536563/);
  assert.match(filas[0], /1 × Guardamanos Protector Puños Moto Enduro Cross ABS - Negro \(17\)/);
  const excluidas = await crm.page.textContent('#gesta-excluidas');
  assert.match(excluidas, /#2000018888888888 · .* · \$100,00 — Sin código de Gesta: Extensor espejo \(EXT-1\)/);
  assert.match(await crm.page.textContent('#gesta-btn-bajar'), /Descargar Excel/);
});

test('el Excel que baja es el que Gesta importa: fecha de Excel, consumidor final, precio de MELI', async () => {
  const [descarga] = await Promise.all([
    crm.page.waitForEvent('download'),
    crm.page.click('#gesta-btn-bajar'),
  ]);
  assert.strictEqual(descarga.suggestedFilename(), 'gesta-2000015853536563.xlsx');
  const wb = XLSX.read(fs.readFileSync(await descarga.path()), { cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  assert.deepStrictEqual(filas[0].slice(0, 14), ['TIPO', 'FECHA', 'TIPO DOCUMENTO', 'DOCUMENTO', 'MONEDA', 'FORMA DE PAGO',
    'VENCIMIENTO', 'CÓDIGO PRODUCTO', 'DETALLE PRODUCTO', 'DETALLE ADICIONAL', 'CANTIDAD', 'PRECIO UNITARIO', 'DESCUENTO', 'ADENDA']);
  const [y, m, d] = HOY.split('-').map(Number);
  const serial = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  assert.deepStrictEqual(filas[1].slice(0, 14), ['eTicket', serial, null, null, 'UYU', 'Contado', null, 17,
    'Guardamanos Protector Puños Moto Enduro Cross ABS - Negro', null, 1, 635.84, null, 'Venta Mercado Libre #2000015853536563']);
  assert.strictEqual(ws.B2.t, 'n');
  assert.strictEqual(ws.B2.z, 'dd/mm/yyyy', 'la fecha tiene formato de fecha, no es texto');
  assert.strictEqual(filas.length, 2, 'una sola venta por archivo');
});

test('marcar como facturadas pide confirmación, la saca del Excel y queda esperando el PDF', async () => {
  await crm.page.click('#gesta-btn-marcar');
  await crm.page.waitForFunction(() => document.querySelector('#gesta-tbody').textContent.includes('No hay ventas MELI sin facturar'));
  assert.strictEqual(crm.alertas.length, 1);
  assert.match(crm.alertas[0], /¿Ya importaste en Gesta esta venta\?/);
  assert.deepStrictEqual(crm.estado.ventasPut.filter(p => p.facturada === true).map(p => p.id), ['V_MELI_2000019328655326_X']);
  await crm.page.click('#modal-gesta .btn-ghost');
  assert.match(await celdaDeVenta('2000019328655326'), /Falta PDF/);
});

// PDF de prueba: el texto que "lee" el pdf.js falso va adentro del archivo.
const pdfConTexto = texto => Buffer.from(`%PDF-1.4\n%TEXTO:${texto}\n%%EOF`, 'latin1');

test('el PDF del eTicket se reconoce por la adenda y se sube a esa venta', async () => {
  await crm.page.evaluate(() => {
    window.pdfjsLib = {
      GlobalWorkerOptions: {},
      getDocument: ({ data }) => ({ promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => {
          const s = new TextDecoder('latin1').decode(data);
          return { items: [{ str: (s.match(/%TEXTO:(.*)/) || [])[1] || '' }] };
        } }),
      }) }),
    };
  });
  await crm.page.click('#btn-facturas-meli');
  await crm.page.waitForSelector('#modal-facturas-meli.open');
  await crm.page.setInputFiles('#fm-archivos', [
    { name: 'eTicket A 414.pdf', mimeType: 'application/pdf', buffer: pdfConTexto('e-Ticket A 414 TOTAL $ 635,84 Adenda Venta Mercado Libre #2000015853536563') },
    { name: 'otro.pdf', mimeType: 'application/pdf', buffer: pdfConTexto('e-Ticket A 413 TOTAL 1.490,00') },
  ]);
  await crm.page.waitForFunction(() => document.querySelector('#fm-btn-subir').textContent.includes('Subir 1'));
  const filas = await crm.page.$$eval('#fm-tbody tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  assert.match(filas[0], /eTicket A 414\.pdf\s*#2000015853536563.*\$635,84\s*Lista para subir/);
  assert.doesNotMatch(filas[0], /No encontré este total/);
  assert.match(filas[1], /otro\.pdf.*No encontré la venta: elegila.*Falta la venta/);

  await crm.page.click('#fm-btn-subir');
  await crm.page.waitForFunction(() => document.querySelector('#fm-tbody').textContent.includes('✅ Subida'));
  assert.strictEqual(crm.estado.facturasMeli.length, 1);
  const subida = crm.estado.facturasMeli[0];
  assert.strictEqual(subida.ventaId, 'V_MELI_2000019328655326_X');
  assert.strictEqual(subida.nombre, 'eTicket A 414.pdf');
  assert.match(Buffer.from(subida.pdf, 'base64').toString('latin1'), /^%PDF-1\.4/);
  await crm.page.click('#modal-facturas-meli .btn-ghost');
  assert.match(await celdaDeVenta('2000019328655326'), /En MELI/);
});

test('el código de Gesta se edita en el producto', async () => {
  await crm.page.evaluate(() => editProducto('EXT-1'));
  await crm.page.waitForSelector('#modal-producto.open');
  assert.strictEqual(await crm.page.inputValue('#p-gesta'), '');
  await crm.page.fill('#p-gesta', '57');
  await crm.page.click('#modal-producto .btn-primary');
  await crm.page.waitForFunction(() => db.productos.find(p => p.sku === 'EXT-1').codigoGesta === 57);
  assert.strictEqual(crm.estado.productos.find(p => p.sku === 'EXT-1').codigo_gesta, 57);
});

test('no hubo errores ni alertas de más', () => {
  assert.strictEqual(crm.alertas.length, 1, 'sólo la confirmación de marcar facturadas: ' + JSON.stringify(crm.alertas));
  const reales = erroresReales(crm.errores);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});
