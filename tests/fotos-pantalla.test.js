// La pestaña 🖼️ Fotos por publicación, en el navegador.
//
// La comparación en sí se prueba sin navegador (fotos-angulos.test.js). Lo que se protege
// acá es la pantalla: que muestre las fotos de cada publicación EN ORDEN junto a las de su
// original, que el botón de copiar sólo aparezca donde hay algo que corregir, que lo que
// MELI no deja tocar se muestre igual con el motivo a la vista, y que después de copiar la
// pantalla vuelva a leer el estado en vez de quedarse con el viejo.

const { test } = require('node:test');
const assert = require('node:assert');
const { estadoDemo, abrirCRM, erroresReales } = require('./helpers');

const url = n => `https://http2.mlstatic.com/D_NQ_NP_2X_${n}00000-MLU${n}0000000_092025-F.jpg`;
const f = n => ({ id: `FOTO${n}`, url: url(n) });

const estado = estadoDemo();
estado.fotos = {
  ok: true,
  productos: [{
    sku: 'HP-Q0211',
    nombre: 'Guardamanos Protector Puños Moto',
    original: { meli_id: 'MLU1228725644', titulo: 'Guardamanos Protector Puños Moto Enduro Cross ABS Negro', estado: 'active', permalink: 'https://articulo.mercadolibre.com.uy/MLU-1228725644', catalogo: false, fotos: [f(1), f(2), f(3)] },
    publicaciones: [
      // Al día: mismas fotos, mismo orden.
      { meli_id: 'MLU1504441822', titulo: 'Cubre Manos Para Manubrio De Moto Universal Negro', estado: 'active', permalink: null, catalogo: false, fotos: [f(1), f(2), f(3)], distintas: false, motivo: null, copiable: false },
      // Le falta una foto y además quedó en otro orden: la miniatura es otra.
      { meli_id: 'MLU1504441824', titulo: 'Protector De Manos Para Moto De Calle Y Delivery Negro', estado: 'active', permalink: null, catalogo: false, fotos: [f(3), f(1)], distintas: true, motivo: null, copiable: true },
      // De catálogo: las fotos las pone MELI, no hay nada que copiarle.
      { meli_id: 'MLU1504441899', titulo: 'Guardamanos de catálogo', estado: 'active', permalink: null, catalogo: true, fotos: [f(9)], distintas: true, motivo: 'Es una publicación de catálogo: las fotos las pone MELI.', copiable: false },
    ],
    total: 3,
    distintas: 2,
    copiables: 1,
    trabadas: 1,
  }],
  resumen: { productos: 1, publicaciones: 3, distintas: 2, copiables: 1, trabadas: 1, productos_afectados: 1 },
};

test('la pestaña de fotos de los ángulos', async (t) => {
  const crm = await abrirCRM({ estado });
  t.after(() => crm.cerrar());

  await crm.page.click('.nav-item:has-text("Ángulos de venta")');
  await crm.page.click('#page-angulos .tabs button:has-text("Fotos por publicación")');
  await crm.page.waitForSelector('#btn-fotos-HP-Q0211');

  await t.test('muestra las fotos de cada publicación en orden, contra las de la original', async () => {
    const filas = await crm.page.$$eval('#angulos-tbody tr', trs => trs.map(tr => ({
      texto: tr.innerText.replace(/\s+/g, ' ').trim(),
      fotos: [...tr.querySelectorAll('img')].map(i => i.getAttribute('src')),
    })));

    assert.strictEqual(filas.length, 4, 'la original y sus tres publicaciones');
    assert.deepStrictEqual(filas[0].fotos, [url(1), url(2), url(3)]);
    assert.match(filas[0].texto, /original/);
    // La que está mal se ve tal cual está publicada: otras fotos y en otro orden.
    assert.deepStrictEqual(filas[2].fotos, [url(3), url(1)]);
    assert.match(filas[1].texto, /iguales/);
    assert.match(filas[2].texto, /distintas/);
  });

  await t.test('lo que MELI no deja corregir se muestra con el motivo', async () => {
    const catalogo = await crm.page.$eval('#angulos-tbody tr:nth-child(4)', e => e.innerText);
    assert.match(catalogo, /distintas/);
    assert.match(catalogo, /catálogo/);
    const aviso = await crm.page.$eval('#angulos-aviso', e => e.innerText);
    assert.match(aviso, /no se puede corregir desde acá/);
  });

  await t.test('copia las fotos de la original a la publicación que quedó distinta', async () => {
    await crm.page.click('#btn-fotos-HP-Q0211');
    // Mientras relee, la tabla muestra una sola fila de "leyendo...": se espera a que vuelva
    // la tabla entera, no sólo a que desaparezca el botón.
    await crm.page.waitForFunction(() =>
      document.querySelectorAll('#angulos-tbody tr').length === 4 && !document.getElementById('btn-fotos-HP-Q0211'));

    assert.deepStrictEqual(estado.fotosPost, [{ sku: 'HP-Q0211' }], 'copia sólo ese producto');

    const aviso = crm.alertas.find(a => a.includes('Publicaciones actualizadas'));
    assert.ok(aviso, 'avisa qué se hizo: ' + JSON.stringify(crm.alertas));
    assert.match(aviso, /Publicaciones actualizadas: 1 · Fallidas: 0/);

    // La pantalla vuelve a leer: la que estaba distinta ahora muestra las fotos de la
    // original, en su orden, y ya no hay botón para copiar.
    const fila = await crm.page.$$eval('#angulos-tbody tr', trs => {
      const tr = trs.find(x => x.innerText.includes('Calle Y Delivery'));
      return { texto: tr.innerText, fotos: [...tr.querySelectorAll('img')].map(i => i.getAttribute('src')) };
    });
    assert.deepStrictEqual(fila.fotos, [url(1), url(2), url(3)]);
    assert.match(fila.texto, /iguales/);

    // La de catálogo sigue distinta: no se puede, y la pantalla no finge lo contrario.
    const catalogo = await crm.page.$$eval('#angulos-tbody tr', trs =>
      trs.find(x => x.innerText.includes('catálogo')).innerText);
    assert.match(catalogo, /distintas/);
  });

  await t.test('no hubo errores ni alertas inesperadas', () => {
    assert.deepStrictEqual(erroresReales(crm.errores), []);
    const inesperadas = crm.alertas.filter(a => !/reemplazar las fotos|Publicaciones actualizadas/.test(a));
    assert.deepStrictEqual(inesperadas, []);
  });
});
