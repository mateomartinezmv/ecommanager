// La pantalla 📣 Redes (Instagram y Facebook): el aviso de cuenta sin conectar, la lista de
// publicaciones con sus redes y lo que se manda al programar, publicar ya y cancelar.

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
      { id: 1, tipo: 'carrusel', redes: ['instagram', 'facebook'], imagenes: [URL1, URL2], caption: 'Puños Domino en 5 colores',
        programado_para: '2030-01-01T23:00:00Z', estado: 'programado' },
      { id: 2, tipo: 'post', redes: ['instagram', 'facebook'], imagenes: [URL1], caption: 'Falló', programado_para: '2026-11-01T23:00:00Z',
        estado: 'error', error: 'Facebook: falta el permiso', ig_media_id: 'M1', permalink: 'https://instagram.com/p/ok' },
    ],
  };
  return estado;
}

test('sin cuenta conectada, la pantalla lo avisa y ofrece conectar', async () => {
  const { page, errores, cerrar } = await abrirCRM({ estado: estadoConInstagram(null) });
  try {
    await page.evaluate(() => goPage('instagram'));
    await page.waitForSelector('#ig-tbody tr');
    assert.match(await page.textContent('#ig-aviso'), /todavía no están conectados/);
    assert.strictEqual((await page.textContent('#ig-btn-conectar')).trim(), '🔗 Conectar Meta');
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
    assert.match(filas[0], /Carrusel.*Instagram.*Facebook.*Puños Domino.*Programado.*Publicar ya.*Cancelar/s);
    assert.match(filas[1], /Error.*falta el permiso.*Reintentar/s);
    // La red que ya salió queda con su link; la que falta, sin link.
    assert.strictEqual(await page.getAttribute('#ig-tbody tr:nth-child(2) a.badge', 'href'), 'https://instagram.com/p/ok');
    assert.strictEqual(await page.$$eval('#ig-tbody tr:nth-child(2) a.badge', as => as.length), 1);
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
    assert.deepStrictEqual(enviado.redes, ['instagram', 'facebook']);
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

test('se puede programar solo para Facebook, y sin ninguna red no se manda nada', async () => {
  const { page, estado, errores, alertas, cerrar } = await abrirCRM({ estado: estadoConInstagram({ ig_user_id: 'IG1' }) });
  try {
    await page.evaluate(() => goPage('instagram'));
    await page.waitForSelector('#ig-tbody tr');
    await page.selectOption('#ig-tipo', 'post');
    await page.fill('#ig-imagenes', URL1);
    await page.fill('#ig-fecha', '2030-03-01T20:00');
    await page.uncheck('#ig-red-instagram');
    await page.uncheck('#ig-red-facebook');
    await page.click('#ig-btn-programar');
    assert.match(alertas[0] || '', /al menos una red/);
    assert.strictEqual((estado.instagram.posts || []).length, 0);

    await page.check('#ig-red-facebook');
    await page.click('#ig-btn-programar');
    await page.waitForFunction(() => document.querySelectorAll('#ig-tbody tr').length === 3);
    assert.deepStrictEqual(estado.instagram.posts[0].redes, ['facebook']);
    assert.deepStrictEqual(erroresReales(errores), []);
  } finally { await cerrar(); }
});
