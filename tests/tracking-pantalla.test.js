// Importaciones → 🚢 Tracking, en el navegador (importaciones.html con su propio mock de la API).
//
// Arranca con el contenedor real PCIU 891912-8 de PIL (fixtures/) con las PIs 13772, 14175 y
// 14713, que se habían calculado para el 12/12, el 02/01 y el 15/01 y llegan juntas el 26/12.
// Cubre: el chip del contenedor en la tabla de Importaciones, la tarjeta (arribo, zarpe, lo
// que falta pagar, la ruta, los movimientos y cada PI contra lo calculado), la reconsulta
// automática al abrir la solapa, marcar pagado el saldo de una PI, el alta de un contenedor
// de PIL (con el dígito de control) y de uno de otra naviera cargado a mano, y el estado sin
// la migración.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { erroresReales, servirPublic } = require('./helpers');
const { parsearPIL } = require('../api/_pil');
const { normalizarTracking, aplicarConsulta } = require('../api/_tracking');

const PIL = parsearPIL(require('./fixtures/pil-PCIU8919128.json').data);
const HACE_5_HORAS = new Date(Date.now() - 5 * 3600 * 1000).toISOString();

function estadoBase() {
  const importaciones = [
    { id: 'IMP-13772', fecha: '2026-09-24', llegada: '2026-12-26', estado: 'ordered', notas: 'PI13772', proveedor_id: 'P-TOM',
      traslado: 13, nacional: 1076, total: 1926, saldo_pendiente: false,
      items: [{ sku: 'DFB-002', nombre: 'Deflector', qty: 40, costo: 5.8 }, { sku: 'GZ', nombre: 'Gato elevador', qty: 30, costo: 11.5 }, { sku: 'ESP', nombre: 'Espejos', qty: 60, costo: 4.333333 }] },
    { id: 'IMP-14175', fecha: '2026-10-13', llegada: '2026-12-26', estado: 'ordered', notas: 'PI14175', proveedor_id: 'P-APOLLO',
      traslado: 23, nacional: 1312, total: 2003, saldo_pendiente: true,
      items: [{ sku: 'BAUL45', nombre: 'Baúl 45L', qty: 20, costo: 7.9 }, { sku: 'BAUL28', nombre: 'Baúl 28L', qty: 30, costo: 8 }, { sku: 'ESC', nombre: 'Escape', qty: 18, costo: 13.5 }, { sku: 'T', nombre: 'Muestras', qty: 1, costo: 27 }] },
    { id: 'IMP-14713', fecha: '2026-10-30', llegada: '2026-12-26', estado: 'ordered', notas: null, proveedor_id: 'P-MUXUAN',
      traslado: 8, nacional: 466.5, total: 890, saldo_pendiente: true,
      items: [{ sku: 'PATENTE', nombre: 'Porta matrícula eléctrico', qty: 15, costo: 25 }, { sku: 'SENAL', nombre: 'Señaleros LED', qty: 30, costo: 1.38 }] },
    { id: 'IMP-NUEVA', fecha: '2026-11-11', llegada: '2027-01-25', estado: 'ordered', notas: 'PI 261107001', proveedor_id: 'P-TOM',
      traslado: 0, nacional: 0, total: 500, saldo_pendiente: true, items: [{ sku: 'SLIDER', nombre: 'Slider', qty: 20, costo: 10 }] },
    { id: 'IMP-VIEJA', fecha: '2026-06-01', llegada: '2026-09-01', estado: 'recibido', notas: 'PI9106', proveedor_id: 'P-TOM', total: 900, items: [] },
  ];
  const fila = normalizarTracking({
    naviera: 'PIL', contenedor: 'PCIU8919128',
    importaciones: [
      { id: 'IMP-13772', pi: '13772', descripcion: 'Accesorios para moto', llegada_calculada: '2026-12-12' },
      { id: 'IMP-14175', pi: '14175', descripcion: 'Valijas, caños de escape y accesorios para moto', llegada_calculada: '2027-01-02' },
      { id: 'IMP-14713', pi: '14713', descripcion: 'Señaleros y portamatrículas', llegada_calculada: '2027-01-15' },
    ],
  });
  const { cambios } = aplicarConsulta({ ...fila, eta_historial: [] }, PIL, { ahora: HACE_5_HORAS });
  return {
    importaciones,
    proveedores: [
      { id: 'P-TOM', nombre: 'Tom Banana', minimo_usd: 300 },
      { id: 'P-APOLLO', nombre: 'Apollo Yi', minimo_usd: 300 },
      { id: 'P-MUXUAN', nombre: 'Guangzhou Muxuan Trading', minimo_usd: 300 },
    ],
    trackings: [{ id: 'TRK-1', ...fila, ...cambios, updated_at: HACE_5_HORAS, created_at: HACE_5_HORAS }],
    posts: [],
  };
}

// Imita a /api/tracking: con PIL completa lo de la consulta y mueve la llegada de las PIs.
function servidorTracking(estado, t) {
  const sync = { actualizadas: [], errores: [] };
  for (const v of t.importaciones || []) {
    const imp = estado.importaciones.find(i => i.id === v.id);
    if (imp && t.eta && imp.llegada !== t.eta) { sync.actualizadas.push({ id: imp.id, llegada: t.eta }); imp.llegada = t.eta; }
  }
  return sync;
}

function mockear(page, estado) {
  return page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const ruta = url.pathname.replace('/api', '');
    const metodo = route.request().method();
    const cuerpo = route.request().postData() ? JSON.parse(route.request().postData()) : {};
    const ok = d => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    estado.posts.push({ ruta: ruta + url.search, metodo, cuerpo });

    if (ruta === '/productos') return ok([]);
    if (ruta === '/proveedores') return ok({ proveedores: estado.proveedores, migracionPendiente: false });
    if (ruta === '/importaciones') {
      if (metodo === 'PUT') {
        const imp = estado.importaciones.find(i => i.id === url.searchParams.get('id'));
        Object.assign(imp, cuerpo);
        return ok(imp);
      }
      return ok(estado.importaciones);
    }
    if (ruta === '/tracking') {
      if (estado.sinMigracion) return ok({ trackings: [], migracionPendiente: true });
      const ahora = new Date().toISOString();
      if (metodo === 'POST' && url.searchParams.get('accion') === 'actualizar') {
        const t = estado.trackings.find(x => x.id === url.searchParams.get('id'));
        Object.assign(t, aplicarConsulta(t, PIL, { ahora }).cambios, { updated_at: ahora });
        return ok({ ...t, consulta: { error: null }, importaciones_sync: servidorTracking(estado, t) });
      }
      if (metodo === 'POST') {
        const fila = normalizarTracking(cuerpo);
        let t = { id: 'TRK-NUEVO', ...fila, eta_historial: [], updated_at: ahora };
        t.importaciones = t.importaciones.map(v => ({ ...v, llegada_calculada: estado.importaciones.find(i => i.id === v.id)?.llegada || null }));
        if (t.naviera === 'PIL') Object.assign(t, aplicarConsulta(t, PIL, { ahora }).cambios);
        estado.trackings.unshift(t);
        return ok({ ...t, consulta: t.naviera === 'PIL' ? { error: null } : null, importaciones_sync: servidorTracking(estado, t) });
      }
      if (metodo === 'DELETE') {
        estado.trackings = estado.trackings.filter(x => x.id !== url.searchParams.get('id'));
        return ok({ ok: true });
      }
      return ok({ trackings: estado.trackings, migracionPendiente: false });
    }
    return ok([]);
  });
}

async function abrir(estado, hash = '') {
  const servidor = servirPublic();
  const browser = await chromium.launch({ args: ['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errores = [];
  const alertas = [];
  page.on('pageerror', e => errores.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  page.on('dialog', async d => { alertas.push(d.message()); await d.accept(); });
  await mockear(page, estado);
  await page.goto(`http://127.0.0.1:${servidor.address().port}/importaciones.html${hash}`);
  const cerrar = async () => { await browser.close(); servidor.close(); };
  return { page, estado, errores, alertas, cerrar };
}

let ui;
before(async () => {
  ui = await abrir(estadoBase());
  await ui.page.waitForSelector('#imports-table-container table');
});
after(async () => { if (ui) await ui.cerrar(); });

const pedidos = (ruta, metodo) => ui.estado.posts.filter(p => p.ruta.startsWith(ruta) && p.metodo === metodo);

test('la tabla de importaciones marca en qué contenedor viaja cada PI', async () => {
  const chips = await ui.page.$$eval('#imports-table-container tbody tr', trs => trs.map(tr => [tr.dataset.id, tr.querySelector('.trk-chip')?.textContent.trim() || null]));
  assert.deepStrictEqual(chips, [
    ['IMP-13772', '🚢 PCIU 891912-8'], ['IMP-14175', '🚢 PCIU 891912-8'], ['IMP-14713', '🚢 PCIU 891912-8'],
    ['IMP-NUEVA', null], ['IMP-VIEJA', null],
  ]);
  assert.strictEqual(await ui.page.textContent('#count-tracking'), '1');
});

test('el chip abre la solapa Tracking en la tarjeta del contenedor', async () => {
  await ui.page.click('tr[data-id="IMP-14175"] .trk-chip');
  await ui.page.waitForSelector('#trk-TRK-1');
  assert.ok(await ui.page.isVisible('#sec-tracking'));
  assert.ok(!(await ui.page.isVisible('#sec-importaciones')));
});

test('al abrir la solapa se vuelve a consultar PIL lo que hace más de 2 horas no se mira', async () => {
  await ui.page.waitForFunction(() => !document.querySelector('#trk-TRK-1 .trk-acciones button[disabled]'));
  const consultas = pedidos('/tracking?accion=actualizar', 'POST');
  assert.strictEqual(consultas.length, 1);
  assert.strictEqual(consultas[0].ruta, '/tracking?accion=actualizar&id=TRK-1');
  assert.match(await ui.page.textContent('#trk-TRK-1 .trk-foot'), /Consultado en PIL (recién|hace \d+ min)/);
  assert.deepStrictEqual(ui.alertas, [], 'la consulta automática no muestra carteles');
});

test('la tarjeta muestra buque, etapa, arribo, zarpe y lo que falta pagar para el 26/12', async () => {
  const card = '#trk-TRK-1';
  assert.match(await ui.page.textContent(`${card} .trk-num`), /PCIU 891912-8\s*PIL\s*⚓ En la terminal de origen/);
  assert.match(await ui.page.textContent(`${card} .trk-buque`), /COSCO SHIPPING RHINE · viaje VCSN0043W/);
  assert.strictEqual(await ui.page.textContent('#trk-eta-TRK-1'), '26/12/2026');
  assert.match(await ui.page.textContent(`${card} .trk-kpi.eta .lbl`), /Arribo estimado a Montevideo/);
  assert.match(await ui.page.textContent(`${card} .trk-kpis .trk-kpi:nth-child(2)`), /Zarpe de Ningbo\s*21\/11\/2026/);
  assert.strictEqual(await ui.page.textContent('#trk-pagar-TRK-1'), 'USD 557.70');
  assert.match(await ui.page.textContent(`${card} .trk-kpi.pago .lbl`), /Falta abonar para el 26\/12/);
  assert.match(await ui.page.textContent(`${card} .trk-kpi.pago .sub`), /PI 14175: USD 345\.50 · PI 14713: USD 212\.20/);
  assert.match(await ui.page.textContent('#trk-stat-pagar'), /USD 557\.70/);
  assert.match(await ui.page.textContent(`${card} .trk-puertos`), /Ningbo\s*CNNGB · zarpe ~21\/11\s*Montevideo\s*UYMVD · arribo ~26\/12/);
});

test('avisa que las 3 llegadas calculadas se juntan en una sola', async () => {
  const nota = await ui.page.textContent('#trk-nota-TRK-1');
  assert.match(nota, /habías calculado 3 llegadas distintas \(12\/12\/2026, 02\/01\/2027 y 15\/01\/2027\)/);
  assert.match(nota, /llegan todas el 26\/12\/2026/);
});

test('cada movimiento de PIL en castellano: lo que pasó, lo estimado y lo pendiente', async () => {
  const hitos = await ui.page.$$eval('#trk-TRK-1 .trk-hito', els => els.map(e => [
    e.classList.contains('ok') ? 'ok' : e.classList.contains('est') ? 'estimado' : 'pendiente',
    e.querySelector('.trk-hito-txt').textContent.trim(),
    e.querySelector('.trk-hito-fecha').textContent.trim(),
  ]));
  assert.deepStrictEqual(hitos, [
    ['ok', 'Retiraron el contenedor vacío para cargarlo', '12/11/2026'],
    ['ok', 'Entró a la terminal del puerto', '15/11/2026'],
    ['estimado', 'Cargado en el buque', '~ 21/11/2026'],
    ['estimado', 'Descargado del buque', '~ 26/12/2026'],
    ['pendiente', 'Salió de la terminal', 'pendiente'],
    ['pendiente', 'Devolvieron el contenedor vacío', 'pendiente'],
  ]);
});

test('cada PI contra lo que se había calculado y su saldo', async () => {
  const filas = await ui.page.$$eval('#trk-TRK-1 .trk-pis tbody tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim())));
  assert.deepStrictEqual(filas.map(f => [f[0].slice(0, 8), f[1], f[3], f[4].split(' ')[0]]), [
    ['PI 13772', 'Tom Banana', '12/12/2026', '+14'],
    ['PI 14175', 'Apollo Yi', '02/01/2027', '−7'],
    ['PI 14713', 'Guangzhou Muxuan Trading', '15/01/2027', '−20'],
  ]);
  assert.match(filas[0][5], /✓ Pagada/);
  assert.match(filas[1][5], /USD 345\.50\s*2da mitad de la PI de USD 691\.00/);
  assert.match(filas[2][2], /Señaleros y portamatrículas/);
});

test('marcar pagado el saldo de una PI baja lo que falta pagar', async () => {
  await ui.page.click('#trk-TRK-1 tr[data-imp="IMP-14175"] button:text("Marcar pagada")');
  await ui.page.waitForFunction(() => document.getElementById('trk-pagar-TRK-1').textContent === 'USD 212.20');
  assert.match(ui.alertas.pop(), /Marcar como pagada la 2da mitad de la PI 14175 \(USD 345\.50\)/);
  assert.deepStrictEqual(pedidos('/importaciones?id=IMP-14175', 'PUT').pop().cuerpo, { saldo_pendiente: false });
  assert.match(await ui.page.textContent('#trk-TRK-1 tr[data-imp="IMP-14175"]'), /✓ Pagada/);
});

test('un número de contenedor mal copiado se avisa con el dígito de control', async () => {
  await ui.page.click('button:text("+ Nuevo contenedor")');
  await ui.page.waitForSelector('#modal-tracking.open');
  await ui.page.fill('#trk-contenedor', 'MSCU 123456-7');
  assert.match(await ui.page.textContent('#trk-contenedor-ayuda'), /no coincide con el de control \(debería ser 6\)/);
  await ui.page.fill('#trk-contenedor', 'mscu1234566');
  assert.match(await ui.page.textContent('#trk-contenedor-ayuda'), /✓ MSCU 123456-6 — número válido/);
  // Las PIs que ya viajan en el otro contenedor no se pueden marcar; las recibidas ni aparecen.
  const filas = await ui.page.$$eval('#trk-imps .trk-imp-row', rs => rs.map(r => [r.dataset.id, r.querySelector('.trk-imp-chk').disabled]));
  assert.deepStrictEqual(filas, [['IMP-13772', true], ['IMP-14175', true], ['IMP-14713', true], ['IMP-NUEVA', false]]);
  assert.strictEqual(await ui.page.inputValue('#trk-imps [data-id="IMP-NUEVA"] .trk-imp-pi'), '261107001', 'el número de PI sale de las notas');
});

test('un contenedor de otra naviera se carga a mano con su arribo', async () => {
  await ui.page.selectOption('#trk-naviera', 'MSC');
  assert.ok(await ui.page.isVisible('#trk-link'), 'pide el link de seguimiento');
  assert.ok(await ui.page.$eval('#trk-manual', d => d.open), 'abre los datos del viaje');
  await ui.page.fill('#trk-link', 'www.msc.com/track?c=MSCU1234566');
  await ui.page.check('#trk-imps [data-id="IMP-NUEVA"] .trk-imp-chk');
  await ui.page.fill('#trk-imps [data-id="IMP-NUEVA"] .trk-imp-desc', 'Sliders');
  await ui.page.fill('#trk-eta', '2027-01-20');
  await ui.page.selectOption('#trk-estado', 'navegando');
  await ui.page.click('#trk-guardar');
  await ui.page.waitForSelector('#trk-TRK-NUEVO');

  const post = pedidos('/tracking', 'POST').filter(p => !p.ruta.includes('accion')).pop().cuerpo;
  assert.strictEqual(post.naviera, 'MSC');
  assert.strictEqual(post.contenedor, 'MSCU1234566');
  assert.strictEqual(post.eta, '2027-01-20');
  assert.strictEqual(post.estado, 'navegando');
  assert.strictEqual(post.etd, null, 'con una naviera manual se manda todo, para poder borrar una fecha');
  assert.deepStrictEqual(post.importaciones, [{ id: 'IMP-NUEVA', pi: '261107001', descripcion: 'Sliders' }]);

  const card = '#trk-TRK-NUEVO';
  assert.match(await ui.page.textContent(`${card} .trk-foot`), /MSC no se consulta sola/);
  assert.ok(!(await ui.page.$(`${card} button:text("Actualizar")`)), 'sin botón de consulta');
  assert.strictEqual(await ui.page.getAttribute(`${card} a:text("Ver en la naviera")`, 'href'), 'https://www.msc.com/track?c=MSCU1234566');
  assert.match(await ui.page.textContent(`${card} .trk-num`), /🚢 Navegando/);
  // La importación tomó el arribo del contenedor.
  await ui.page.click('#tab-importaciones');
  assert.match(await ui.page.textContent('tr[data-id="IMP-NUEVA"]'), /20\/01\/2027\s*🚢 MSCU 123456-6/);
});

test('un contenedor de PIL se carga sólo con el número: lo demás lo trae la consulta', async () => {
  await ui.page.click('#tab-tracking');
  await ui.page.click('#trk-TRK-NUEVO button[title="Borrar el contenedor"]');
  await ui.page.waitForFunction(() => !document.getElementById('trk-TRK-NUEVO'));
  assert.match(ui.alertas.pop(), /Borrar el contenedor MSCU 123456-6\?.*conservan la llegada/s);

  await ui.page.click('button:text("+ Nuevo contenedor")');
  await ui.page.fill('#trk-contenedor', 'PCIU 891912-8');
  assert.ok(!(await ui.page.isVisible('#trk-link')), 'PIL no necesita link');
  await ui.page.check('#trk-imps [data-id="IMP-NUEVA"] .trk-imp-chk');
  await ui.page.click('#trk-guardar');
  await ui.page.waitForSelector('#trk-TRK-NUEVO');
  const post = pedidos('/tracking', 'POST').filter(p => !p.ruta.includes('accion')).pop().cuerpo;
  assert.deepStrictEqual(Object.keys(post).sort(), ['contenedor', 'importaciones', 'link_seguimiento', 'naviera', 'notas'],
    'con PIL no se mandan fechas ni etapa vacías que pisen la consulta');
  assert.strictEqual(await ui.page.textContent('#trk-eta-TRK-NUEVO'), '26/12/2026');
  assert.deepStrictEqual(erroresReales(ui.errores), []);
});

test('sin la migración la solapa explica qué correr', async () => {
  const estado = estadoBase();
  estado.sinMigracion = true;
  const otra = await abrir(estado, '#tracking');
  try {
    await otra.page.waitForSelector('#aviso-migracion-tracking');
    assert.match(await otra.page.textContent('#aviso-migracion-tracking'), /20261118000000_add_trackings\.sql/);
    await otra.page.click('button:text("+ Nuevo contenedor")');
    assert.match(otra.alertas.pop(), /Falta correr la migración/);
    assert.deepStrictEqual(erroresReales(otra.errores), []);
  } finally {
    await otra.cerrar();
  }
});
