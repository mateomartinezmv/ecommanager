// La etiqueta de envío 100 × 150 mm de las ventas de mostrador (botón 🏷️).
//
// Lo que se protege: que salga con el nombre, el teléfono (que vive en la ficha del
// cliente, no en el envío) y la dirección; que un carrito lleve todos sus productos; que
// una venta sin envío pida primero la dirección y la etiqueta salga al guardarlo; y que
// las ventas de MELI no tengan este botón (usan la etiqueta que da MELI).

const { test } = require('node:test');
const assert = require('node:assert');
const { HOY, estadoDemo, abrirCRM, erroresReales } = require('./helpers');

const estado = estadoDemo();
estado.ventas.push(
  { id: 'V-2', canal: 'mostrador', fecha: HOY, sku: 'SKU2', producto: 'Espejo redondo', cantidad: 1,
    precio_unit: 700, comision: 0, total: 700, estado: 'pagada', metodo_pago: 'efectivo',
    cliente: 'Juan Pérez', cliente_id: 'C-1', created_at: HOY },
  // Carrito: dos líneas, el cliente sin ficha vinculada (se busca por nombre).
  { id: 'V-3', canal: 'mostrador', fecha: HOY, venta_grupo: 'G-9', sku: 'SKU1', producto: 'Slider', cantidad: 2,
    precio_unit: 1000, comision: 0, total: 2000, estado: 'pagada', metodo_pago: 'efectivo',
    cliente: 'Ana Gómez', created_at: HOY },
  { id: 'V-4', canal: 'mostrador', fecha: HOY, venta_grupo: 'G-9', sku: 'SKU2', producto: 'Espejo redondo', cantidad: 1,
    precio_unit: 700, comision: 0, total: 700, estado: 'pagada', metodo_pago: 'efectivo',
    cliente: 'Ana Gómez', created_at: HOY },
);
estado.clientes = [
  { id: 'C-1', nombre: 'Juan Pérez', telefono: '099 123 456' },
  { id: 'C-2', nombre: 'Ana Gómez', telefono: '098 765 432' },
];
estado.envios = [
  { id: 'E-1', venta_id: 'V-3', orden: 'G-9', comprador: 'Ana Gómez', producto: 'Slider x2 + Espejo redondo x1',
    transportista: 'ues', fecha_despacho: HOY, estado: 'pendiente', direccion: 'Bvar. Artigas 1500, La Comercial',
    zona: 2, costo: 150, created_at: HOY },
];

// jsPDF viene de un CDN que no carga offline: se reemplaza por uno que anota lo escrito,
// y la apertura del PDF se intercepta para leer qué salió.
async function prepararCaptura(page) {
  await page.evaluate(() => {
    window.__etiquetas = [];
    window.jspdf = { jsPDF: function (opts) {
      const textos = [];
      const doc = new Proxy({}, { get: (obj, k) => {
        if (k in obj) return obj[k];
        if (k === 'text') return (t) => { textos.push([].concat(t).join(' ')); };
        if (k === 'getTextWidth') return (t) => String(t).length * 2;
        if (k === 'splitTextToSize') return (t) => [String(t)];
        return () => {};
      } });
      doc.__opts = opts; doc.__textos = textos;
      return doc;
    } };
    window.abrirComprobanteParaImprimir = (doc, nombre) => {
      window.__etiquetas.push({ formato: doc.__opts.format, texto: doc.__textos.join('\n'), nombre });
    };
  });
}

test('etiqueta de envío de mostrador', async (t) => {
  const crm = await abrirCRM({ estado });
  t.after(() => crm.cerrar());
  const { page } = crm;
  await prepararCaptura(page);
  await page.click(`.nav-item[onclick="goPage('ventas')"]`);

  await t.test('solo las ventas de mostrador tienen el botón', async () => {
    const meli = await page.$$('#ventas-tbody tr:has-text("Slider"):not(:has-text("Carrito")) button[title^="Imprimir etiqueta de envío"]');
    assert.strictEqual(meli.length, 0);
  });

  await t.test('carrito con envío: nombre, teléfono por nombre, dirección y todos los productos', async () => {
    await page.click('#ventas-tbody tr:has-text("Carrito") button[title^="Imprimir etiqueta de envío"]');
    const [e] = await page.evaluate(() => window.__etiquetas.splice(0));
    assert.deepStrictEqual(e.formato, [100, 150]);
    assert.match(e.texto, /Ana Gómez/);
    assert.match(e.texto, /098 765 432/);
    assert.match(e.texto, /Bvar\. Artigas 1500, La Comercial/);
    assert.match(e.texto, /ZONA 2/);
    assert.match(e.texto, /ENVÍO/);
    assert.doesNotMatch(e.texto, /UES/, 'el transportista no va en la etiqueta');
    assert.match(e.texto, /Slider x2 \+ Espejo redondo x1/);
  });

  await t.test('venta sin envío: pide la dirección y la etiqueta sale al guardar', async () => {
    await page.click('#ventas-tbody tr:not(:has-text("Carrito")):has-text("Espejo redondo") button[title^="Imprimir etiqueta de envío"]');
    await page.waitForSelector('#modal-envio.open');
    await page.fill('#env-direccion', 'Av. Italia 3000, Malvín');
    await page.click('#modal-envio button:has-text("Guardar envío")');
    await page.waitForFunction(() => window.__etiquetas.length > 0);
    const [e] = await page.evaluate(() => window.__etiquetas.splice(0));
    assert.match(e.texto, /Juan Pérez/);
    assert.match(e.texto, /099 123 456/, 'el teléfono sale de la ficha vinculada a la venta');
    assert.match(e.texto, /Av\. Italia 3000, Malvín/);
    assert.ok(estado.envios.some(x => x.venta_id === 'V-2'), 'el envío quedó guardado');
  });

  await t.test('desde la lista de envíos también se imprime', async () => {
    await page.click(`.nav-item[onclick="goPage('envios')"]`);
    await page.click('#envios-tbody tr:has-text("Ana Gómez") button[title^="Imprimir etiqueta de envío"]');
    const [e] = await page.evaluate(() => window.__etiquetas.splice(0));
    assert.match(e.texto, /Ana Gómez/);
  });

  assert.deepStrictEqual(erroresReales(crm.errores), []);
  assert.deepStrictEqual(crm.alertas, []);
});
