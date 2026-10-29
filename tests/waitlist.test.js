// Waitlist en la pantalla: anotar a un cliente desde Clientes → 🔔 con el SKU que espera, y
// verlo en Stock → 🔔 Waitlist filtrado por SKU, con el botón que abre WhatsApp con el
// mensaje armado para los que ya llegó su importación.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { HOY, estadoDemo, abrirCRM, erroresReales, leerTarjetas } = require('./helpers');

let crm;
const valor = (tarjetas, etiqueta) => (tarjetas.find(t => t.etiqueta.startsWith(etiqueta)) || {}).valor;

function estadoWaitlist() {
  const estado = estadoDemo();
  estado.clientes = [
    { id: 'CLI1', nombre: 'Juan Pérez', telefono: '099 123 456', canal_origen: 'mostrador', created_at: HOY },
    { id: 'CLI2', nombre: 'Ana Gómez', telefono: null, canal_origen: 'mostrador', email: 'ana@x.com', notas: 'cliente fiel', created_at: HOY },
  ];
  estado.importaciones = [
    { id: 'IMP1', fecha: '2026-10-01', llegada: '2026-10-20', estado: 'recibido', items: [{ sku: 'SKU3', qty: 5 }] },
    { id: 'IMP2', fecha: '2026-10-15', llegada: '2026-12-01', estado: 'en_transito', items: [{ sku: 'SKU2', qty: 3 }] },
  ];
  // Juan esperaba el espejo cuadrado y ya llegó la importación que lo trae.
  estado.avisos = [
    { id: 'AV1', cliente_id: 'CLI1', sku: 'SKU3', cantidad: 1, nota: null, estado: 'listo', importacion_id: 'IMP1',
      created_at: '2026-09-20T12:00:00Z', listo_at: '2026-10-20T12:00:00Z', avisado_at: null },
  ];
  return estado;
}

const avisoDe = (clienteId, sku) => crm.estado.avisos.find(a => a.cliente_id === clienteId && a.sku === sku);

async function irA(page, pagina) {
  await page.click(`.nav-item[onclick="goPage('${pagina}')"]`);
}

async function abrirWaitlist(page) {
  await irA(page, 'stock');
  await page.click(`#page-stock .tab:has-text("Waitlist")`);
  await page.waitForSelector('#stock-wait-panel', { state: 'visible' });
}

before(async () => {
  crm = await abrirCRM({ estado: estadoWaitlist() });
  // wa.me se abre en otra pestaña: se captura la URL en vez de abrirla.
  await crm.page.evaluate(() => { window.__abiertas = []; window.open = url => { window.__abiertas.push(url); return null; }; });
});

after(async () => { if (crm) await crm.cerrar(); });

test('desde Clientes se anota el SKU que espera; sin teléfono lo pide y lo guarda en la ficha', async () => {
  const { page } = crm;
  await irA(page, 'clientes');
  await page.click('#clientes-tbody tr:has-text("Ana Gómez") button[title^="Avisar cuando vuelva"]');
  await page.waitForSelector('#modal-aviso-stock.open');

  await page.fill('#aviso-producto-search', 'redondo');
  await page.click('#aviso-producto-dd div[data-sku="SKU2"]');
  const info = await page.textContent('#aviso-producto-sel');
  assert.match(info, /Hoy tiene 4 en stock/, 'avisa que hoy tiene stock');
  assert.match(info, /llega 2026-12-01/, 'muestra la importación en camino');

  // Sin teléfono no se puede avisar por WhatsApp.
  await page.click('#btn-aviso-guardar');
  assert.match(crm.alertas.pop() || '', /Cargá el teléfono/);
  assert.strictEqual(avisoDe('CLI2', 'SKU2'), undefined);

  await page.fill('#aviso-telefono', '098 765 432');
  await page.fill('#aviso-cantidad', '2');
  await page.fill('#aviso-nota', 'lo quiere para el lunes');
  await page.click('#btn-aviso-guardar');
  await page.waitForSelector('#aviso-lista tr:has-text("SKU2")');

  const a = avisoDe('CLI2', 'SKU2');
  assert.strictEqual(a.estado, 'esperando');
  assert.strictEqual(a.cantidad, 2);
  assert.strictEqual(a.nota, 'lo quiere para el lunes');
  const ana = crm.estado.clientes.find(c => c.id === 'CLI2');
  assert.strictEqual(ana.telefono, '098 765 432');
  assert.strictEqual(ana.email, 'ana@x.com', 'guardar el teléfono no borra el resto de la ficha');
  assert.strictEqual(ana.notas, 'cliente fiel');

  // El mismo SKU otra vez: ya está esperando.
  await page.fill('#aviso-producto-search', 'SKU2');
  await page.click('#aviso-producto-dd div[data-sku="SKU2"]');
  await page.click('#btn-aviso-guardar');
  assert.match(crm.alertas.pop() || '', /ya está esperando SKU2/);
  assert.strictEqual(crm.estado.avisos.filter(x => x.cliente_id === 'CLI2').length, 1);

  await page.click('#modal-aviso-stock button:text-is("Cerrar")');
  assert.strictEqual((await page.textContent('#clientes-tbody tr:has-text("Ana Gómez") button[title^="Espera"]')).trim(), '🔔 1');
});

test('la Waitlist agrupa por SKU, pone primero lo que hay que avisar y filtra por SKU', async () => {
  const { page } = crm;
  await abrirWaitlist(page);
  assert.ok(!(await page.isVisible('#stock-tabla')), 'la tabla de inventario queda tapada');

  const tarjetas = await leerTarjetas(page, '#stock-wait-stats');
  assert.strictEqual(valor(tarjetas, 'Para avisar'), '1');
  assert.strictEqual(valor(tarjetas, 'Esperando'), '1');
  assert.strictEqual(valor(tarjetas, 'Productos pedidos'), '2');
  assert.strictEqual(valor(tarjetas, 'Pedidos sin importación'), '0', 'SKU2 viene en IMP2');

  const filas = await page.$$eval('#wait-tbody tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  assert.match(filas[0], /SKU3 Espejo cuadrado .*Llegó en la importación del 2026-10-01/);
  assert.match(filas[1], /Juan Pérez.*099 123 456.*Para avisar/);
  assert.match(filas[2], /SKU2 Espejo redondo .*Piden 2 uds .*llega 2026-12-01/);
  assert.match(filas[3], /Ana Gómez.*lo quiere para el lunes.*098 765 432.*Esperando/);

  await page.selectOption('#wait-sku', 'SKU2');
  const soloSku2 = await page.$$eval('#wait-tbody tr', trs => trs.map(t => t.textContent));
  assert.strictEqual(soloSku2.length, 2);
  assert.ok(soloSku2.join(' ').includes('Ana Gómez') && !soloSku2.join(' ').includes('Juan Pérez'));
  await page.selectOption('#wait-sku', '');
});

test('📱 Avisar abre WhatsApp con el mensaje y deja el aviso como avisado', async () => {
  const { page } = crm;
  await page.click('#wait-tbody tr:has-text("Juan Pérez") button:has-text("Avisar")');
  await page.waitForFunction(() => window.__abiertas.length === 1);
  const url = decodeURIComponent((await page.evaluate(() => window.__abiertas[0])));
  assert.match(url, /^https:\/\/wa\.me\/59899123456\?text=/);
  assert.match(url, /Hola Juan! .*Ya nos volvió a entrar Espejo cuadrado/);

  await page.waitForFunction(() => db.avisos.find(a => a.id === 'AV1').estado === 'avisado');
  assert.strictEqual(avisoDe('CLI1', 'SKU3').estado, 'avisado');
  // Con el filtro por defecto (abiertos) desaparece; en "Avisados" está.
  assert.ok(!(await page.textContent('#wait-tbody')).includes('Juan Pérez'));
  await page.selectOption('#wait-estado', 'avisado');
  assert.ok((await page.textContent('#wait-tbody')).includes('Juan Pérez'));
  await page.selectOption('#wait-estado', 'abiertos');
});

test('✕ saca al cliente de la waitlist', async () => {
  const { page } = crm;
  await page.click('#wait-tbody tr:has-text("Ana Gómez") button[title="Ya no lo espera"]');
  assert.match(crm.alertas.pop() || '', /Sacar a Ana Gómez de la waitlist de SKU2/);
  await page.waitForSelector('#wait-empty', { state: 'visible' });
  assert.strictEqual(avisoDe('CLI2', 'SKU2').estado, 'cancelado');
});

test('la pantalla no dejó errores', () => {
  assert.deepStrictEqual(erroresReales(crm.errores), []);
  assert.deepStrictEqual(crm.alertas, [], 'no quedaron alert() sin verificar');
});

test('sin la migración la Waitlist explica qué falta y el resto del CRM anda', async () => {
  const estado = estadoWaitlist();
  estado.sinAvisos = true;
  const otro = await abrirCRM({ estado });
  try {
    await abrirWaitlist(otro.page);
    assert.match(await otro.page.textContent('#stock-wait-aviso'), /20261029000000_add_avisos_stock\.sql/);
    await irA(otro.page, 'clientes');
    await otro.page.click('#clientes-tbody tr:has-text("Juan Pérez") button[title^="Avisar cuando vuelva"]');
    assert.ok(await otro.page.isDisabled('#btn-aviso-guardar'), 'no deja anotar sin la tabla');
    assert.match(await otro.page.textContent('#aviso-migracion'), /Falta correr la migración/);
    assert.deepStrictEqual(erroresReales(otro.errores), []);
  } finally {
    await otro.cerrar();
  }
});
