// La pantalla 📸 Fotos (Marketing): elegir producto y variantes, revisar los textos antes de
// gastar, seguir la generación y publicar en MELI. Con la API mockeada (tests/helpers.js).

const { test } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, erroresReales, estadoDemo } = require('./helpers');

const IMG = n => `https://cdn.example.com/${n}.jpg`;

function estadoConFotos(extra = {}) {
  const estado = estadoDemo();
  estado.productos.push(
    { sku: 'NEG', nombre: 'Manillar 22mm - Negro', grupo: 'Manillares', subgrupo: 'Universal 7/8', meli_id: 'MLU1', meli_ids: ['MLU1', 'MLU2'],
      stock_dep: 3, stock_meli: 3, precio: 1000, costo: 400, alerta_min: 1, discontinuado: false },
    { sku: 'ROJ', nombre: 'Manillar 22mm - Rojo', grupo: 'Manillares', subgrupo: 'Universal 7/8', meli_id: 'MLU9', meli_ids: ['MLU9'],
      stock_dep: 3, stock_meli: 3, precio: 1000, costo: 400, alerta_min: 1, discontinuado: false },
    { sku: 'AZU', nombre: 'Manillar 22mm - Azul', grupo: 'Manillares', subgrupo: 'Universal 7/8', meli_id: null, meli_ids: [],
      stock_dep: 0, stock_meli: 0, precio: 1000, costo: 400, alerta_min: 1, discontinuado: false },
  );
  estado.fotosIA = {
    preparar: {
      variantes: [
        { sku: 'NEG', nombre: 'Manillar 22mm - Negro', color: 'Negro', referencias: [IMG('neg')], aviso: null },
        { sku: 'ROJ', nombre: 'Manillar 22mm - Rojo', color: 'Rojo', referencias: [IMG('rojo')], aviso: null },
      ],
      textos: {
        medidas: { titulo: 'MEDIDAS', subtitulo: 'Manillar de aluminio', datos: ['80 cm de largo', 'Ø 28 mm centro'], destacados: ['ALUMINIO ANODIZADO'] },
        compatible: { titulo: 'COMPATIBLE CON TU MOTO', etiquetas: ['CALLE', 'NAKED'], verificaciones: ['Ø 22 mm'], escena: 'en una moto naked' },
        beneficios: { titulo: '¿POR QUÉ CAMBIARLO?', items: ['Más control'] },
        instalacion: { titulo: 'INSTALACIÓN', pasos: ['Aflojá', 'Colocá'], escena: '' },
      },
      avisoTextos: null,
    },
    ...extra,
  };
  return estado;
}

const foto = (id, sku, tipo, estado, more = {}) => ({ id, lote: 'LOTE-1', sku, tipo, estado, compartida: false, url_final: estado === 'lista' ? IMG(`${sku}-${tipo}`) : null, error: null, ...more });

async function prepararManillares(page) {
  await page.evaluate(() => goPage('fotos'));
  await page.waitForSelector('#fia-familia option[value^="g:Manillares"]', { state: 'attached' });
  await page.selectOption('#fia-familia', 'g:Manillares|Universal 7/8');
  await page.click('#fia-btn-preparar');
  await page.waitForSelector('#fia-paso2', { state: 'visible' });
}

test('elige el producto por grupo y muestra sus variantes; las que no están en MELI quedan sin marcar', async () => {
  const { page, errores, cerrar } = await abrirCRM({ estado: estadoConFotos({ configurado: { higgsfield: false, ia: true } }) });
  try {
    await page.evaluate(() => goPage('fotos'));
    await page.waitForSelector('#fia-aviso', { state: 'visible' });
    assert.match(await page.textContent('#fia-aviso'), /HIGGSFIELD_API_KEY/);
    const opciones = await page.$$eval('#fia-familia option', os => os.map(o => o.textContent));
    assert.ok(opciones.includes('Manillares / Universal 7/8 (3 variantes)'), opciones.join(' | '));

    await page.selectOption('#fia-familia', 'g:Manillares|Universal 7/8');
    const marcadas = await page.$$eval('.fia-var', cs => cs.map(c => [c.value, c.checked]));
    assert.deepStrictEqual(marcadas, [['NEG', true], ['ROJ', true], ['AZU', false]]);
    assert.match(await page.textContent('#fia-variantes'), /sin publicación en MELI/);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('preparar muestra las fotos de referencia y los textos propuestos, editables, sin gastar', async () => {
  const { page, estado, errores, cerrar } = await abrirCRM({ estado: estadoConFotos() });
  try {
    await prepararManillares(page);
    assert.deepStrictEqual(estado.fotosIA.llamadas.map(l => l.accion), ['preparar']);
    assert.deepStrictEqual(estado.fotosIA.llamadas[0].cuerpo.skus, ['NEG', 'ROJ']);
    assert.strictEqual(await page.$$eval('.fia-ref', els => els.length), 2);
    assert.strictEqual(await page.inputValue('#fia-t-med-datos'), '80 cm de largo\nØ 28 mm centro');
    assert.strictEqual(await page.inputValue('#fia-t-com-titulo'), 'COMPATIBLE CON TU MOTO');
    // 4 tipos × 2 variantes + 1 instalación para las dos.
    assert.strictEqual((await page.textContent('#fia-btn-generar')).trim(), '🎨 Generar 9 imágenes');

    await page.uncheck('#fia-tipo-instalacion');
    assert.strictEqual((await page.textContent('#fia-btn-generar')).trim(), '🎨 Generar 8 imágenes');
    await page.uncheck('#fia-tipo-medidas');
    assert.strictEqual(await page.isVisible('#fia-t-med-datos'), false, 'los textos de lo que no se genera se ocultan');
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('generar manda los textos corregidos, sólo las variantes con foto, y sigue el lote hasta que termina', async () => {
  const estado = estadoConFotos();
  estado.fotosIA.preparar.variantes.push({ sku: 'AZU', nombre: 'Manillar 22mm - Azul', referencias: [], aviso: 'No tiene publicación de MELI enlazada.' });
  estado.fotosIA.alGenerar = [foto(1, 'NEG', 'portada', 'pendiente'), foto(2, 'NEG', 'medidas', 'pendiente'), foto(3, 'ROJ', 'portada', 'pendiente')];
  estado.fotosIA.avances = [
    [foto(1, 'NEG', 'portada', 'generando'), foto(2, 'NEG', 'medidas', 'generando'), foto(3, 'ROJ', 'portada', 'generando')],
    [foto(1, 'NEG', 'portada', 'lista'), foto(2, 'NEG', 'medidas', 'error', { error: 'Higgsfield no pudo generarla (no se cobra).' }), foto(3, 'ROJ', 'portada', 'lista')],
  ];
  const { page, alertas, errores, cerrar } = await abrirCRM({ estado });
  try {
    await page.evaluate(() => { FIA_INTERVALO_MS = 50; });
    await prepararManillares(page);
    assert.match(await page.textContent('#fia-referencias'), /No tiene publicación de MELI enlazada/);
    await page.uncheck('#fia-tipo-compatible');
    await page.uncheck('#fia-tipo-beneficios');
    await page.uncheck('#fia-tipo-instalacion');
    await page.fill('#fia-t-med-datos', '80 cm de largo\nØ 22 mm en todo el manillar');
    assert.strictEqual((await page.textContent('#fia-btn-generar')).trim(), '🎨 Generar 4 imágenes', 'el azul sin foto no cuenta');
    await page.click('#fia-btn-generar');

    // El título arranca como "3 · Resultado" en el HTML: se espera el del lote ya terminado.
    await page.waitForFunction(() => /Resultado \(3 imágenes\)/.test(document.getElementById('fia-resultado-titulo').textContent));
    const gen = estado.fotosIA.llamadas.find(l => l.accion === 'generar').cuerpo;
    assert.deepStrictEqual(gen.tipos, ['portada', 'medidas']);
    assert.deepStrictEqual(gen.variantes.map(v => v.sku), ['NEG', 'ROJ']);
    assert.deepStrictEqual(gen.textos.medidas.datos, ['80 cm de largo', 'Ø 22 mm en todo el manillar']);
    assert.match(alertas[0], /4 imágenes en Higgsfield/);
    assert.strictEqual(estado.fotosIA.llamadas.filter(l => l.accion === 'avanzar').length, 2, 'deja de avanzar cuando no queda nada en camino');
    assert.deepStrictEqual(estado.fotosIA.llamadas.filter(l => l.accion === 'avanzar').map(l => l.cuerpo.lote), ['LOTE-1', 'LOTE-1']);

    // Una tarjeta por imagen, con su estado; el error se lee.
    const tarjetas = await page.$$eval('.fia-foto', els => els.map(e => [e.dataset.tipo, e.dataset.estado]));
    assert.deepStrictEqual(tarjetas, [['portada', 'lista'], ['medidas', 'error'], ['portada', 'lista']]);
    assert.match(await page.textContent('.fia-variante[data-sku="NEG"]'), /no pudo generarla/);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('publicar en MELI manda el lote, el SKU y si se conservan las actuales; muestra lo que falló', async () => {
  const estado = estadoConFotos({
    fotos: [foto(1, 'NEG', 'portada', 'lista'), foto(2, 'NEG', 'medidas', 'lista'), foto(5, 'NEG', 'instalacion', 'lista', { compartida: true }), foto(3, 'ROJ', 'portada', 'lista')],
    lotes: [{ lote: 'LOTE-1', created_at: '2026-11-07T15:00:00Z', skus: ['NEG', 'ROJ'], total: 4, listas: 4, publicadas: 0, activas: 0, errores: 0 }],
    alPublicar: { ok: true, publicadas: 1, fallidas: 1, resultados: [{ meli_id: 'MLU1', ok: true }, { meli_id: 'MLU2', ok: false, error: 'Es una publicación de catálogo: las fotos las pone MELI.' }] },
  });
  const { page, alertas, errores, cerrar } = await abrirCRM({ estado });
  try {
    await page.evaluate(() => goPage('fotos'));
    await page.waitForSelector('#fia-lotes tr');
    assert.match(await page.textContent('#fia-lotes'), /Manillar 22mm - Negro/);
    await page.click('#fia-lotes button');
    await page.waitForSelector('.fia-variante[data-sku="NEG"]');
    // La de instalación aparece una vez, para todas.
    assert.match(await page.textContent('#fia-lote'), /Para todas las variantes/);

    await page.check('#fia-conservar');
    await page.click('.fia-variante[data-sku="NEG"] .fia-btn-publicar');
    await page.waitForFunction(() => /publicación actualizada/.test(document.querySelector('.fia-variante[data-sku="NEG"]').textContent));
    const pub = estado.fotosIA.llamadas.find(l => l.accion === 'publicar').cuerpo;
    assert.deepStrictEqual(pub, { lote: 'LOTE-1', sku: 'NEG', conservar: true });
    assert.match(alertas[0], /Se suman las fotos nuevas/);
    const msg = await page.textContent('.fia-variante[data-sku="NEG"] .fia-msg');
    assert.match(msg, /1 publicación actualizada/);
    assert.match(msg, /MLU2: Es una publicación de catálogo/);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('publicar todas recorre cada variante con fotos listas', async () => {
  const estado = estadoConFotos({
    fotos: [foto(1, 'NEG', 'portada', 'lista'), foto(3, 'ROJ', 'portada', 'lista')],
    lotes: [{ lote: 'LOTE-1', created_at: '2026-11-07T15:00:00Z', skus: ['NEG', 'ROJ'], total: 2, listas: 2, publicadas: 0, activas: 0, errores: 0 }],
  });
  const { page, alertas, errores, cerrar } = await abrirCRM({ estado });
  try {
    await page.evaluate(() => goPage('fotos'));
    await page.waitForSelector('#fia-lotes tr');
    await page.click('#fia-lotes button');
    await page.click('#fia-btn-publicar-todas');
    await page.waitForFunction(() => document.querySelectorAll('.fia-msg').length === 2 && ![...document.querySelectorAll('.fia-msg')].some(m => /Publicando/.test(m.textContent)));
    assert.deepStrictEqual(estado.fotosIA.llamadas.filter(l => l.accion === 'publicar').map(l => l.cuerpo.sku), ['NEG', 'ROJ']);
    assert.strictEqual(alertas.length, 1, 'una sola confirmación para todas');
    assert.match(alertas[0], /REEMPLAZAN las fotos en MELI de 2 variantes/);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('sin la migración, la pantalla lo avisa', async () => {
  const { page, errores, cerrar } = await abrirCRM({ estado: estadoConFotos({ faltaMigracion: true }) });
  try {
    await page.evaluate(() => goPage('fotos'));
    await page.waitForSelector('#fia-aviso', { state: 'visible' });
    assert.match(await page.textContent('#fia-aviso'), /migración de fotos con IA/);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});
