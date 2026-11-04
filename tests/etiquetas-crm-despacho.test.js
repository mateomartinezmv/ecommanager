// ✅ Control de despacho → 🖨️ con las etiquetas del CRM (mostrador y Shopify, 100 × 150).
//
// Lo que se protege: que los envíos de mostrador y Shopify tengan casilla y estado propio
// (🏷️ sin imprimir / impresa / falta dirección); que "Las que faltan imprimir" y "Todas" los
// incluyan; que elegir de los dos tipos dé UN solo PDF (las de MELI y las del CRM unidas),
// con una página por etiqueta del CRM; que sólo las del CRM no le pregunten nada a MELI; que
// la impresión quede anotada en el envío y sobreviva a recargar; que si no se pueden unir,
// las del CRM se descarguen aparte; y que sin la migración se imprima igual y se avise.

const { test } = require('node:test');
const assert = require('node:assert');
const { HOY, abrirCRM, erroresReales } = require('./helpers');

function estadoCRM() {
  const venta = (id, extra) => ({ id, fecha: HOY, sku: 'SKU1', producto: 'Espejos Alerón', cantidad: 1,
    precio_unit: 1458, comision: 0, total: 1458, estado: 'pagada', metodo_pago: 'transferencia', created_at: HOY, ...extra });
  const envio = (id, ventaId, comprador, extra) => ({ id, venta_id: ventaId, comprador, producto: 'Espejos Alerón',
    estado: 'pendiente', created_at: HOY, ...extra });
  return {
    productos: [{ sku: 'SKU1', nombre: 'Espejos Alerón', tipo: 'nuevo', stock_dep: 10, stock_meli: 10, costo: 400,
      precio: 1458, alerta_min: 1, created_at: HOY }],
    ventas: [
      venta('V_SHOP_540283_1', { canal: 'shopify', comprador: 'Rubén Marín', cliente: 'Rubén Marín', cliente_id: 'CLI_SHOP_1' }),
      venta('V-MOS', { canal: 'mostrador', cliente: 'Ernesto Sanguinet', cliente_id: 'C-1' }),
      venta('V-VIEJA', { canal: 'mostrador', cliente: 'Jon Aleksanyan' }),
      venta('V_MELI', { canal: 'meli', orden_meli: '2000000000000099', comprador: 'Alexis', comision: 200 }),
    ],
    clientes: [
      { id: 'CLI_SHOP_1', nombre: 'Rubén Marín', telefono: '096 111 222' },
      { id: 'C-1', nombre: 'Ernesto Sanguinet', telefono: '099 333 444' },
    ],
    envios: [
      envio('E_SHOP_540283', 'V_SHOP_540283_1', 'Rubén Marín', { orden: '#540283', transportista: 'enviosuy', direccion: 'Defensa 1827, Montevideo' }),
      envio('E-MOS', 'V-MOS', 'Ernesto Sanguinet', { transportista: 'ues', direccion: 'Rivera 100, Melo' }),
      // Se imprimió ayer: lo dice la columna, aunque la página se haya recargado.
      envio('E-VIEJA', 'V-VIEJA', 'Jon Aleksanyan', { transportista: 'dac', direccion: 'Sarandí 50, Salto', etiqueta_impresa_at: `${HOY}T10:00:00Z` }),
      envio('E_MELI_99', 'V_MELI', 'Alexis', { orden: '2000000000000099', transportista: 'mercado_envios', tracking: 'MEL44000000099FMDOF01' }),
    ],
    etiquetasMeliEstado: { E_MELI_99: { impresa: false, imprimible: true, status: 'ready_to_ship', substatus: 'ready_to_print' } },
  };
}

// jsPDF y pdf-lib vienen de un CDN que no carga sin red: se reemplazan por unos que anotan
// qué se armó y qué se unió.
async function prepararPdfs(page, { unirFalla = false } = {}) {
  await page.evaluate((unirFalla) => {
    window.__pdfsCrm = []; window.__unidas = []; window.__descargados = [];
    window.jspdf = { jsPDF: function (opts) {
      const paginas = [[]];
      const doc = new Proxy({}, { get: (obj, k) => {
        if (k === 'text') return (t) => { paginas[paginas.length - 1].push([].concat(t).join(' ')); };
        if (k === 'addPage') return () => { paginas.push([]); };
        if (k === 'getTextWidth') return (t) => String(t).length * 2;
        if (k === 'splitTextToSize') return (t) => [String(t)];
        if (k === 'output') return (tipo) => (tipo === 'arraybuffer' ? new TextEncoder().encode('%PDF-crm').buffer : new Blob(['%PDF-crm'], { type: 'application/pdf' }));
        if (k === 'save') return (nombre) => { window.__descargados.push(nombre); };
        return () => {};
      } });
      window.__pdfsCrm.push({ formato: opts.format, paginas });
      return doc;
    } };
    window.PDFLib = { PDFDocument: {
      create: async () => {
        if (unirFalla) throw new Error('pdf-lib roto');
        return { copyPages: async (src, idx) => idx.map(() => ({ src: src.nombre })), addPage: p => window.__unidas.push(p.src),
          save: async () => new Uint8Array([37, 80, 68, 70]) };
      },
      load: async (b) => ({ nombre: new TextDecoder().decode(new Uint8Array(b)).slice(0, 8), getPageIndices: () => [0] }),
    } };
  }, unirFalla);
}

const casillas = page => page.$$eval('#desp-lista .desp-check', cs => cs.map(c => ({ id: c.dataset.id, elegida: c.checked, bloqueada: c.disabled })));
const elegidas = async page => (await casillas(page)).filter(c => c.elegida).map(c => c.id).sort();
const fila = (page, id) => page.textContent(`#desp-lista .desp-fila[data-id="${id}"]`);
const aviso = page => page.textContent('#desp-etq-aviso');
async function imprimir(page) {
  const [ventana] = await Promise.all([page.waitForEvent('popup'), page.click('#desp-imprimir')]);
  await page.waitForFunction(() => !/Armando/.test(document.getElementById('desp-imprimir').textContent));
  return ventana;
}

test('etiquetas del CRM en el control de despacho', async (t) => {
  const crm = await abrirCRM({ estado: estadoCRM() });
  t.after(() => crm.cerrar());
  const { page, estado } = crm;
  await prepararPdfs(page);
  await page.click(`.nav-item[onclick="goPage('despacho')"]`);
  await page.waitForFunction(() => /🖨️ Sin imprimir/.test(document.getElementById('desp-lista').textContent));

  await t.test('Shopify y mostrador tienen casilla y su estado de etiqueta', async () => {
    const ids = (await casillas(page)).map(c => c.id).sort();
    assert.deepStrictEqual(ids, ['E-MOS', 'E-VIEJA', 'E_MELI_99', 'E_SHOP_540283']);
    assert.match(await fila(page, 'E_SHOP_540283'), /🏷️ Sin imprimir/);
    assert.match(await fila(page, 'E-MOS'), /🏷️ Sin imprimir/);
    assert.match(await fila(page, 'E-VIEJA'), /🏷️ Impresa/, 'lo impreso antes de recargar sigue figurando');
    assert.match(await fila(page, 'E_MELI_99'), /🖨️ Sin imprimir/);
  });

  await t.test('"las que faltan" junta las del CRM y las de MELI sin imprimir', async () => {
    await page.click('#desp-lista button:text-is("Las que faltan imprimir")');
    assert.deepStrictEqual(await elegidas(page), ['E-MOS', 'E_MELI_99', 'E_SHOP_540283']);
  });

  await t.test('de los dos tipos sale un solo PDF', async () => {
    await imprimir(page);
    assert.deepStrictEqual(estado.etiquetasPedidas.at(-1), ['E_MELI_99'], 'a MELI se le piden sólo las suyas');
    const pdf = await page.evaluate(() => window.__pdfsCrm.at(-1));
    assert.deepStrictEqual(pdf.formato, [100, 150]);
    assert.strictEqual(pdf.paginas.length, 2, 'una página por etiqueta del CRM');
    assert.ok(pdf.paginas.some(p => p.join(' ').includes('Defensa 1827')));
    assert.ok(pdf.paginas.some(p => p.join(' ').includes('Rivera 100')));
    assert.deepStrictEqual(await page.evaluate(() => window.__unidas), ['%PDF-1.4', '%PDF-crm'], 'MELI primero, después las del CRM');
    assert.match(await aviso(page), /3 etiqueta\(s\) en el PDF \(1 de MELI y 2 del CRM\)/);
  });

  await t.test('las del CRM quedan anotadas como impresas', async () => {
    const puts = (estado.enviosPut || []).filter(p => p.etiquetaImpresaAt).map(p => p.id).sort();
    assert.deepStrictEqual(puts, ['E-MOS', 'E_SHOP_540283']);
    assert.match(await fila(page, 'E_SHOP_540283'), /🏷️ Impresa/);
    assert.deepStrictEqual(await elegidas(page), []);
  });

  await t.test('sólo del CRM: no le pregunta nada a MELI y no hace falta unir', async () => {
    const pedidosAntes = estado.etiquetasPedidas.length;
    const unidasAntes = await page.evaluate(() => window.__unidas.length);
    await page.check('#desp-lista .desp-check[data-id="E-VIEJA"]');
    await imprimir(page);
    assert.strictEqual(estado.etiquetasPedidas.length, pedidosAntes);
    assert.strictEqual(await page.evaluate(() => window.__unidas.length), unidasAntes);
    assert.strictEqual((await page.evaluate(() => window.__pdfsCrm.at(-1))).paginas.length, 1);
    assert.match(await aviso(page), /1 etiqueta\(s\) en el PDF/);
  });

  await t.test('la etiqueta suelta 🏷️ de Envíos sigue andando', async () => {
    await page.click(`.nav-item[onclick="goPage('envios')"]`);
    const [ventana] = await Promise.all([page.waitForEvent('popup'), page.click('#envios-tbody tr:has-text("Rubén Marín") button[title^="Imprimir etiqueta de envío"]')]);
    assert.ok(ventana);
    assert.ok((await page.evaluate(() => window.__pdfsCrm.at(-1))).paginas[0].join(' ').includes('Defensa 1827'));
  });

  await t.test('no hubo errores', () => {
    const reales = erroresReales(crm.errores);
    assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
    assert.deepStrictEqual(crm.alertas, []);
  });
});

test('si no se pueden unir, las del CRM se descargan aparte', async (t) => {
  const crm = await abrirCRM({ estado: estadoCRM() });
  t.after(() => crm.cerrar());
  const { page } = crm;
  await prepararPdfs(page, { unirFalla: true });
  await page.click(`.nav-item[onclick="goPage('despacho')"]`);
  await page.waitForFunction(() => /🖨️ Sin imprimir/.test(document.getElementById('desp-lista').textContent));
  await page.click('#desp-lista button:text-is("Todas")');
  await imprimir(page);
  assert.deepStrictEqual(await page.evaluate(() => window.__descargados.length), 1);
  assert.match(await aviso(page), /se descargaron en un PDF aparte/);
});

test('sin la migración se imprime igual y se avisa', async (t) => {
  const crm = await abrirCRM({ estado: { ...estadoCRM(), sinEtiquetaImpresa: true } });
  t.after(() => crm.cerrar());
  const { page } = crm;
  await prepararPdfs(page);
  await page.click(`.nav-item[onclick="goPage('despacho')"]`);
  await page.waitForSelector('#desp-lista .desp-check[data-id="E-MOS"]');
  await page.check('#desp-lista .desp-check[data-id="E-MOS"]');
  await imprimir(page);
  await page.waitForSelector('#desp-aviso:visible');
  assert.match(await page.textContent('#desp-aviso'), /20261103010000_add_etiqueta_impresa\.sql/);
  assert.match(await fila(page, 'E-MOS'), /🏷️ Impresa/, 'mientras la página siga abierta, se recuerda');
  const reales = erroresReales(crm.errores, [/503/]);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});
