// 🏷️ Promos MELI, como la usa el vendedor: qué ve de cada publicación, qué botones le
// ofrece según la regla, y qué le manda al backend al aceptar. La API está mockeada con
// publicaciones armadas por el mismo armarPublicacion que usa el endpoint.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { servirPublic } = require('./helpers');
const { armarPublicacion } = require('../api/meli/promos');

let servidor, browser, page;
const posts = [];

function fixture() {
  const soporte = { sku: 'SOP-CEL-ESP-001', nombre: 'Soporte celular', costo: 88, stock: 84, vendidas60: 30,
    dias_stock: 168, segmento: 'quieto', segmento_txt: 'No se vende', meli_ids: ['MLU1503030820'] };
  const parabrisas = { sku: 'HP-DF028', nombre: 'Parabrisas', costo: 1000, stock: 1, vendidas60: 2,
    dias_stock: 30, segmento: 'liquidar', segmento_txt: 'Discontinuado', meli_ids: ['MLU698507115'] };
  const espejos = { sku: 'HSJ-20121', nombre: 'Espejos alerón', costo: 342, stock: 13, vendidas60: 50,
    dias_stock: 16, segmento: 'bien', segmento_txt: 'Se vende bien', meli_ids: ['MLU884316822'] };

  soporte.publicaciones = [armarPublicacion(soporte,
    { meli_id: 'MLU1503030820', titulo: 'Soporte Celular Moto', precio: 490 },
    [{ id: 'P-28', type: 'SMART', status: 'candidate', price: 352.8, original_price: 490, offer_id: 'OF1', name: 'Ganar exposición' },
     { id: 'P-10S', type: 'LIGHTNING', status: 'candidate', price: 441, original_price: 490, name: 'Relámpago' }],
    { sugerido: 420, actual: 490 })];
  parabrisas.publicaciones = [armarPublicacion(parabrisas,
    { meli_id: 'MLU698507115', titulo: 'Parabrisas 45cm', precio: 2790 },
    [{ id: 'P-42', type: 'SMART', status: 'candidate', price: 1629.6, original_price: 2790, name: 'Ganar exposición' }],
    { sugerido: 1500, actual: 2790 })];
  espejos.publicaciones = [armarPublicacion(espejos,
    { meli_id: 'MLU884316822', titulo: 'Espejos Aleron', precio: 1690 },
    [{ id: 'P-10', type: 'PRICE_DISCOUNT', status: 'started', price: 1100, original_price: 1690, name: 'Descuento' }],
    null)];
  const productos = [soporte, parabrisas, espejos];
  const props = productos.flatMap(p => p.publicaciones.flatMap(x => x.propuestas));
  return {
    ok: true, productos,
    resumen: {
      aceptar: props.filter(p => p.evaluacion.veredicto === 'aceptar').length,
      contraoferta: 0,
      rechazar: props.filter(p => p.evaluacion.veredicto === 'rechazar').length,
      vigentes_fuera_de_regla: 1, precio_alto: 2,
    },
  };
}

before(async () => {
  servidor = servirPublic();
  // Mismo criterio que helpers.abrirCRM: CHROMIUM_PATH para un Chromium que no es el de esta versión.
  browser = await chromium.launch({ args: ['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  page = await browser.newPage();
  await page.route('**/fonts.googleapis.com/**', r => r.abort());
  await page.route('**/api/meli/promos', async r => {
    if (r.request().method() === 'POST') {
      posts.push(JSON.parse(r.request().postData()));
      return r.fulfill({ json: { ok: true, precio: 352.8 } });
    }
    return r.fulfill({ json: fixture() });
  });
  page.on('dialog', d => d.accept());
  await page.goto(`http://localhost:${servidor.address().port}/promos.html`);
  await page.waitForSelector('#tbody tr td .prod-nombre');
});

after(async () => {
  await browser?.close();
  servidor?.close();
});

test('muestra las tres publicaciones para decidir con su veredicto', async () => {
  const texto = await page.textContent('#tbody');
  assert.match(texto, /Soporte Celular Moto/);
  assert.match(texto, /Parabrisas 45cm/);
  assert.match(texto, /Espejos Aleron/);   // tiene un 35% corriendo: fuera de regla
  assert.match(texto, /Fuera de regla/);
});

test('el 28% en el stock quieto se ofrece aceptar; el 42% no tiene botón', async () => {
  const soporte = page.locator('tr', { hasText: 'Soporte Celular Moto' });
  assert.strictEqual(await soporte.locator('button', { hasText: 'Aceptar' }).count(), 2);
  const parabrisas = page.locator('tr', { hasText: 'Parabrisas 45cm' });
  assert.strictEqual(await parabrisas.locator('.promo button').count(), 0);
  assert.match(await parabrisas.textContent(), /2 × costo/);
  // Referencia de MELI por debajo de 2×costo: se avisa que no conviene perseguirla.
  assert.match(await parabrisas.textContent(), /Rompe tu piso/);
});

test('aceptar manda la publicación y la promoción al backend', async () => {
  await page.locator('tr', { hasText: 'Soporte Celular Moto' }).locator('button', { hasText: 'Aceptar a $353' }).click();
  await page.waitForFunction(() => document.getElementById('toast').style.display === 'block');
  assert.deepStrictEqual(posts[0], { meli_id: 'MLU1503030820', accion: 'aceptar', promo_id: 'P-28' });
});

test('la promo corriendo fuera de regla ofrece sacarla', async () => {
  const antes = posts.length;
  // Después del POST anterior la pantalla se recarga: esperar a que vuelva la fila.
  const espejos = page.locator('tr', { hasText: 'Espejos Aleron' });
  await espejos.locator('button', { hasText: 'Sacar de la promo' }).click();
  for (let i = 0; i < 50 && posts.length === antes; i++) await page.waitForTimeout(100);
  assert.deepStrictEqual(posts[posts.length - 1], { meli_id: 'MLU884316822', accion: 'sacar', promo_id: 'P-10' });
});

// Espera a que lleguen `n` POST nuevos (o se rinde a los 5 s).
async function esperarPosts(antes, n = 1) {
  for (let i = 0; i < 50 && posts.length < antes + n; i++) await page.waitForTimeout(100);
}

test('aceptar en lote: "Seleccionar todas" marca una por publicación, la de mejor precio', async () => {
  await page.waitForSelector('#cards input[data-grupo="aceptar"]');
  await page.check('#cards input[data-grupo="aceptar"]');
  // Dos propuestas aceptables en el soporte (28% y 10%): queda marcada sólo la de 28%.
  const boton = page.locator('#cards button', { hasText: 'Aceptar (1)' });
  assert.strictEqual(await boton.count(), 1);
  const antes = posts.length;
  await boton.click();
  await esperarPosts(antes);
  await page.waitForFunction(() => document.getElementById('resultado-lote').style.display === 'block');
  assert.deepStrictEqual(posts.slice(antes), [{ meli_id: 'MLU1503030820', accion: 'aceptar', promo_id: 'P-28' }]);
  assert.match(await page.textContent('#resultado-lote'), /1 de 1 aplicadas/);
});

test('rechazar en lote: no llama a MELI, oculta y se puede deshacer', async () => {
  await page.waitForSelector('#cards input[data-grupo="rechazar"]');
  const antes = posts.length;
  await page.check('#cards input[data-grupo="rechazar"]');
  await page.locator('#cards button', { hasText: /^Rechazar \(/ }).click();
  await page.waitForTimeout(200);
  assert.strictEqual(posts.length, antes);
  // El parabrisas sólo tenía esa propuesta: sale de "Para decidir".
  assert.doesNotMatch(await page.textContent('#tbody'), /Parabrisas 45cm/);
  assert.ok((await page.evaluate(() => localStorage.getItem('promos_rechazadas_v1'))).includes('P-42'));
  await page.locator('#cards button', { hasText: 'Volver a mostrar' }).click();
  assert.match(await page.textContent('#tbody'), /Parabrisas 45cm/);
});

test('sacar en lote las promos corriendo fuera de regla', async () => {
  await page.waitForSelector('#cards input[data-grupo="sacar"]');
  await page.check('#cards input[data-grupo="sacar"]');
  const antes = posts.length;
  await page.locator('#cards button', { hasText: 'Sacar (1)' }).click();
  await esperarPosts(antes);
  assert.deepStrictEqual(posts.slice(antes), [{ meli_id: 'MLU884316822', accion: 'sacar', promo_id: 'P-10' }]);
});
