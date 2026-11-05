// La pantalla 📸 Instagram: el aviso de cuenta sin conectar, la lista de publicaciones y
// lo que se manda al programar, publicar ya y cancelar.

const { test } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, erroresReales, estadoDemo } = require('./helpers');

const URL1 = 'https://cdn.example.com/1.jpg';
const URL2 = 'https://cdn.example.com/2.jpg';

function estadoConInstagram(cuenta) {
  const estado = estadoDemo();
  estado.instagram = {
    cuenta,
    publicaciones: [
      { id: 1, tipo: 'carrusel', imagenes: [URL1, URL2], caption: 'Puños Domino en 5 colores',
        programado_para: '2030-01-01T23:00:00Z', estado: 'programado' },
      { id: 2, tipo: 'post', imagenes: [URL1], caption: 'Falló', programado_para: '2026-11-01T23:00:00Z',
        estado: 'error', error: 'Instagram no pudo procesar la imagen' },
    ],
  };
  return estado;
}

test('sin cuenta conectada, la pantalla lo avisa y ofrece conectar', async () => {
  const { page, errores, cerrar } = await abrirCRM({ estado: estadoConInstagram(null) });
  try {
    await page.evaluate(() => goPage('instagram'));
    await page.waitForSelector('#ig-tbody tr');
    assert.match(await page.textContent('#ig-aviso'), /todavía no está conectado/);
    assert.strictEqual((await page.textContent('#ig-btn-conectar')).trim(), '🔗 Conectar Instagram');
    assert.match(await page.textContent('#ig-stats'), /Sin conectar/);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('lista las publicaciones con su estado, el error y las acciones que corresponden', async () => {
  const cuenta = { ig_user_id: 'IG1', ig_username: 'martinezmotos.uy', page_name: 'Martinez Motos' };
  const { page, errores, cerrar } = await abrirCRM({ estado: estadoConInstagram(cuenta) });
  try {
    await page.evaluate(() => goPage('instagram'));
    await page.waitForSelector('#ig-tbody tr');
    assert.strictEqual(await page.isVisible('#ig-aviso'), false);
    assert.match(await page.textContent('#ig-stats'), /@martinezmotos\.uy/);
    const filas = await page.$$eval('#ig-tbody tr', trs => trs.map(t => t.textContent));
    assert.strictEqual(filas.length, 2);
    assert.match(filas[0], /Carrusel.*Puños Domino.*Programado.*Publicar ya.*Cancelar/s);
    assert.match(filas[1], /Error.*no pudo procesar.*Reintentar/s);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('programar manda el carrusel con la fecha en UTC y lo suma a la lista', async () => {
  const { page, estado, errores, alertas, cerrar } = await abrirCRM({ estado: estadoConInstagram({ ig_user_id: 'IG1' }) });
  try {
    await page.evaluate(() => goPage('instagram'));
    await page.waitForSelector('#ig-tbody tr');
    await page.selectOption('#ig-tipo', 'carrusel');
    await page.fill('#ig-imagenes', `${URL1}\n${URL2}`);
    await page.fill('#ig-caption', 'Texto del post #motos');
    await page.fill('#ig-fecha', '2030-03-01T20:00');
    await page.click('#ig-btn-programar');
    await page.waitForFunction(() => document.querySelectorAll('#ig-tbody tr').length === 3);

    const [enviado] = estado.instagram.posts;
    assert.strictEqual(enviado.tipo, 'carrusel');
    assert.strictEqual(enviado.imagenes, `${URL1}\n${URL2}`);
    assert.strictEqual(enviado.caption, 'Texto del post #motos');
    // La hora del formulario es la del navegador; a la API va en ISO para no perder la zona.
    const esperado = await page.evaluate(() => new Date('2030-03-01T20:00').toISOString());
    assert.strictEqual(enviado.programadoPara, esperado);
    // El formulario queda limpio para la próxima.
    assert.strictEqual(await page.inputValue('#ig-imagenes'), '');
    assert.deepStrictEqual(alertas, []);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});

test('publicar ya y cancelar cambian el estado de la fila', async () => {
  const { page, estado, errores, cerrar } = await abrirCRM({ estado: estadoConInstagram({ ig_user_id: 'IG1' }) });
  try {
    await page.evaluate(() => goPage('instagram'));
    await page.waitForSelector('#ig-tbody tr');
    await page.click('#ig-tbody tr:nth-child(1) button:has-text("Publicar ya")');
    await page.waitForSelector('#ig-tbody tr:nth-child(1) :text("Publicado")');
    assert.strictEqual(estado.instagram.publicaciones.find(p => p.id === 1).estado, 'publicado');

    await page.click('#ig-tbody tr:nth-child(2) button:has-text("Cancelar")');
    await page.waitForSelector('#ig-tbody tr:nth-child(2) :text("Cancelado")');
    assert.strictEqual(estado.instagram.publicaciones.find(p => p.id === 2).estado, 'cancelado');
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});
