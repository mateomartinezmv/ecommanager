// Importaciones → 🏭 Proveedores y 🛒 Compras por proveedor, en el navegador.
//
// importaciones.html es una página aparte del SPA (no usa `db`), así que acá se abre con su
// propio mock de la API. Cubre: la importación nueva que exige proveedor y se puede dar de
// alta un proveedor desde el mismo selector; ponerle proveedor a una importación vieja ya
// recibida; la ficha de cada proveedor con sus números; asignar a mano los productos que no
// tienen proveedor; y la compra recomendada, que junta lo que hay que reponer de cada
// proveedor y lo completa hasta su mínimo de USD 300 en costo de China.
//
// Al final, el estado sin la migración y el aviso de 📅 Reposición que separa "sin stock
// hasta que llegue el pedido" de "además pedí N más".

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { HOY, erroresReales, servirPublic } = require('./helpers');

function estadoBase() {
  return {
    proveedores: [
      { id: 'PROV-1', nombre: 'Yiwu Trading', contacto: 'Lily', telefono: '+86 138 0000 1111', wechat: 'yiwu88',
        email: 'lily@yiwu.cn', ubicacion: 'Yiwu, China', web: 'yiwu.en.alibaba.com', minimo_usd: 300, notas: 'Pago 50/50' },
      { id: 'PROV-2', nombre: 'Guangzhou Moto', minimo_usd: 300 },
    ],
    productos: [
      { sku: 'GZ-N', nombre: 'Gato elevador negro', tipo: 'nuevo', stock_dep: 0, proveedor_id: 'PROV-1' },
      { sku: 'GZ-R', nombre: 'Gato elevador rojo', tipo: 'nuevo', stock_dep: 0, proveedor_id: 'PROV-1' },
      { sku: 'BAUL', nombre: 'Baúl 28L', tipo: 'nuevo', stock_dep: 30, proveedor_id: 'PROV-1' },
      { sku: 'DFB', nombre: 'Deflector', tipo: 'nuevo', stock_dep: 50, proveedor_id: 'PROV-2' },
      { sku: 'SINPROV', nombre: 'Puños', tipo: 'nuevo', stock_dep: 1, proveedor_id: null },
      // Ni los usados ni los descatalogados se vuelven a comprar: no se piden asignar.
      { sku: 'USADO', nombre: 'Casco usado', tipo: 'usado', stock_dep: 1, proveedor_id: null },
      { sku: 'VIEJO', nombre: 'Espejo viejo', tipo: 'nuevo', stock_dep: 0, proveedor_id: null, discontinuado: true },
    ],
    importaciones: [
      { id: 'IMP2', fecha: '2026-08-01', llegada: '2026-10-20', estado: 'recibido', proveedor_id: 'PROV-2', total: 120,
        items: [{ sku: 'DFB', nombre: 'Deflector', qty: 40, costo: 2 }] },
      { id: 'IMP1', fecha: '2026-07-01', llegada: '2026-09-20', estado: 'recibido', proveedor_id: 'PROV-1', total: 300,
        items: [{ sku: 'GZ-N', nombre: 'Gato negro', qty: 10, costo: 8 }, { sku: 'GZ-R', nombre: 'Gato rojo', qty: 10, costo: 8 },
                { sku: 'BAUL', nombre: 'Baúl', qty: 5, costo: 12 }] },
      // Cargada antes de que existiera el campo: sin proveedor y ya recibida.
      { id: 'IMP0', fecha: '2026-02-01', llegada: '2026-04-20', estado: 'recibido', proveedor_id: null, total: 50,
        items: [{ sku: 'SINPROV', nombre: 'Puños', qty: 10, costo: 1.5 }] },
    ],
    restock: {
      lead_time_promedio: 85,
      productos: [
        { sku: 'GZ-N', nombre: 'Gato elevador negro', stock: 0, qty_en_transito: 10, daily_velocity: 0.16, unidades_por_venta: 1,
          cantidad_sugerida: 14, restock_status: 'quiebre_confirmado', agota_con_transito: '2027-02-12', punto_pedido_uds: 24 },
        { sku: 'GZ-R', nombre: 'Gato elevador rojo', stock: 0, qty_en_transito: 20, daily_velocity: 0.18, unidades_por_venta: 1,
          cantidad_sugerida: 6, restock_status: 'quiebre_confirmado', agota_con_transito: '2027-04-01', punto_pedido_uds: 26 },
        { sku: 'BAUL', nombre: 'Baúl 28L', stock: 30, qty_en_transito: 0, daily_velocity: 0.28, unidades_por_venta: 1,
          cantidad_sugerida: 0, restock_status: 'cubierto', stockout_date: '2026-12-10', restock_date: '2026-09-16' },
        { sku: 'DFB', nombre: 'Deflector', stock: 50, qty_en_transito: 0, daily_velocity: 0.32, unidades_por_venta: 1,
          cantidad_sugerida: 0, restock_status: 'cubierto', stockout_date: '2027-01-30', restock_date: '2026-11-06' },
        { sku: 'SINPROV', nombre: 'Puños', stock: 1, qty_en_transito: 0, daily_velocity: 0.1, unidades_por_venta: 1,
          cantidad_sugerida: 5, restock_status: 'ordenar_ya' },
      ],
    },
    posts: [],
  };
}

function mockear(page, estado) {
  return page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const ruta = url.pathname.replace('/api', '');
    const metodo = route.request().method();
    const cuerpo = route.request().postData() ? JSON.parse(route.request().postData()) : {};
    const ok = d => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    estado.posts.push({ ruta: ruta + url.search, metodo, cuerpo });

    if (ruta === '/productos') return ok(estado.productos);
    if (ruta === '/restock') return ok(estado.restock);
    if (ruta === '/proveedores') {
      if (estado.sinMigracion) return ok({ proveedores: [], migracionPendiente: true });
      if (metodo === 'POST' && url.searchParams.get('accion') === 'asignar') {
        estado.productos.forEach(p => { if (cuerpo.skus.includes(p.sku)) p.proveedor_id = cuerpo.proveedor_id; });
        return ok({ ok: true });
      }
      if (metodo === 'POST') {
        const p = { id: 'PROV-NUEVO', ...cuerpo, minimo_usd: Number(cuerpo.minimo_usd) || 300 };
        estado.proveedores.push(p);
        return ok(p);
      }
      return ok({ proveedores: estado.proveedores, migracionPendiente: false });
    }
    if (ruta === '/importaciones') {
      if (metodo === 'POST') {
        const imp = { id: 'IMP-NUEVA', ...cuerpo, proveedor_id: estado.sinMigracion ? undefined : cuerpo.proveedor_id };
        estado.importaciones.unshift(imp);
        if (imp.proveedor_id) {
          estado.productos.forEach(p => { if (cuerpo.items.some(i => i.sku === p.sku)) p.proveedor_id = imp.proveedor_id; });
          imp.proveedor_sync = { asignados: cuerpo.items.length };
        }
        return ok(imp);
      }
      if (metodo === 'PUT') {
        const imp = estado.importaciones.find(i => i.id === url.searchParams.get('id'));
        Object.assign(imp, cuerpo);
        if (cuerpo.proveedor_id) {
          estado.productos.forEach(p => { if (imp.items.some(i => i.sku === p.sku)) p.proveedor_id = cuerpo.proveedor_id; });
          return ok({ ...imp, proveedor_sync: { asignados: 1 } });
        }
        return ok(imp);
      }
      return ok(estado.importaciones);
    }
    return ok([]);
  });
}

async function abrir(pagina, estado) {
  const servidor = servirPublic();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errores = [];
  const alertas = [];
  page.on('pageerror', e => errores.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  page.on('dialog', async d => { alertas.push(d.message()); await d.accept(); });
  await mockear(page, estado);
  await page.goto(`http://127.0.0.1:${servidor.address().port}/${pagina}`);
  const cerrar = async () => { await browser.close(); servidor.close(); };
  return { page, estado, errores, alertas, cerrar };
}

let ui;
before(async () => {
  ui = await abrir('importaciones.html', estadoBase());
  await ui.page.waitForSelector('#imports-table-container table');
});
after(async () => { if (ui) await ui.cerrar(); });

const ultimoPost = (ruta, metodo = 'POST') =>
  [...ui.estado.posts].reverse().find(p => p.ruta.startsWith(ruta) && p.metodo === metodo);

test('la tabla de importaciones muestra el proveedor y filtra por él', async () => {
  const filas = await ui.page.$$eval('#imports-table-container tbody tr', trs => trs.map(t => t.cells[1].textContent.trim()));
  assert.ok(filas[0].startsWith('Guangzhou Moto'));
  assert.ok(filas[1].startsWith('Yiwu Trading'));
  await ui.page.selectOption('#filtro-prov-imp', 'PROV-1');
  assert.strictEqual(await ui.page.locator('#imports-table-container tbody tr').count(), 1);
  await ui.page.selectOption('#filtro-prov-imp', '__sin');
  assert.strictEqual(await ui.page.locator('#imports-table-container tbody tr').count(), 1);
  await ui.page.selectOption('#filtro-prov-imp', '');
});

test('a una importación vieja ya recibida se le pone el proveedor desde la tabla', async () => {
  await ui.page.selectOption('tr[data-id="IMP0"] .sel-prov-imp', 'PROV-2');
  await ui.page.waitForSelector('tr[data-id="IMP0"] .celda-prov a');
  assert.deepStrictEqual(ultimoPost('/importaciones?id=IMP0', 'PUT').cuerpo, { proveedor_id: 'PROV-2' });
  assert.strictEqual(ui.estado.productos.find(p => p.sku === 'SINPROV').proveedor_id, 'PROV-2', 'el producto queda asignado');
  // Se vuelve atrás para que los tests siguientes tengan un producto sin proveedor.
  ui.estado.productos.find(p => p.sku === 'SINPROV').proveedor_id = null;
  await ui.page.evaluate(() => { productos.find(p => p.sku === 'SINPROV').proveedor_id = null; compras = {}; });
});

test('una importación nueva no se guarda sin proveedor', async () => {
  await ui.page.click('button:text("+ Nueva Importación")');
  await ui.page.waitForSelector('#modal-nueva.open');
  await ui.page.fill('#line-items-body .li-sku', 'GZ-N');
  await ui.page.fill('#line-items-body .li-qty', '5');
  await ui.page.fill('#new-total-pagado', '100');
  await ui.page.click('#modal-nueva button:text("Guardar importación")');
  assert.match(ui.alertas.pop(), /Elegí de qué proveedor/);
  assert.ok(await ui.page.isVisible('#modal-nueva.open'), 'el modal sigue abierto');
});

test('desde el selector se da de alta un proveedor nuevo y queda elegido', async () => {
  await ui.page.selectOption('#new-proveedor', '__nuevo');
  await ui.page.waitForSelector('#modal-proveedor.open');
  await ui.page.fill('#prov-nombre', 'Ningbo Parts');
  await ui.page.fill('#prov-wechat', 'ningbo1');
  await ui.page.click('#prov-guardar');
  await ui.page.waitForSelector('#modal-proveedor.open', { state: 'hidden' });
  assert.strictEqual(await ui.page.inputValue('#new-proveedor'), 'PROV-NUEVO');
  assert.deepStrictEqual(
    { nombre: ultimoPost('/proveedores').cuerpo.nombre, wechat: ultimoPost('/proveedores').cuerpo.wechat, minimo: ultimoPost('/proveedores').cuerpo.minimo_usd },
    { nombre: 'Ningbo Parts', wechat: 'ningbo1', minimo: '300' });

  await ui.page.fill('#line-items-body .li-cost', '10');
  assert.match(await ui.page.textContent('#new-minimo'), /USD 50\.00 — faltan USD 250\.00 para el mínimo de Ningbo Parts/);
  await ui.page.click('#modal-nueva button:text("Guardar importación")');
  await ui.page.waitForSelector('#modal-nueva.open', { state: 'hidden' });
  const post = ultimoPost('/importaciones');
  assert.strictEqual(post.cuerpo.proveedor_id, 'PROV-NUEVO');
  assert.deepStrictEqual(post.cuerpo.items, [{ sku: 'GZ-N', nombre: '', qty: 5, costo: 10 }]);
  // GZ-N pasó a Ningbo con esa importación; se devuelve a Yiwu para el resto de la suite.
  ui.estado.importaciones.shift();
  ui.estado.productos.find(p => p.sku === 'GZ-N').proveedor_id = 'PROV-1';
  await ui.page.evaluate(() => { imports.shift(); productos.find(p => p.sku === 'GZ-N').proveedor_id = 'PROV-1'; compras = {}; renderTodo(); });
});

test('la ficha del proveedor muestra sus datos, números, productos e importaciones', async () => {
  await ui.page.click('#tab-proveedores');
  await ui.page.click('.prov-chip:has-text("Yiwu Trading")');
  await ui.page.waitForSelector('#panel-proveedor[data-id="PROV-1"]');
  const panel = await ui.page.textContent('#panel-proveedor');
  for (const t of ['Lily', '+86 138 0000 1111', 'yiwu88', 'lily@yiwu.cn', 'Yiwu, China', 'Pago 50/50', 'USD 300.00']) {
    assert.ok(panel.includes(t), 'falta ' + t);
  }
  assert.strictEqual(await ui.page.getAttribute('#panel-proveedor a[href^="https://wa.me/"]', 'href'), 'https://wa.me/8613800001111');
  const stats = await ui.page.$$eval('#prov-stats .stat-card', els => Object.fromEntries(els.map(e =>
    [e.querySelector('.stat-label').textContent.trim(), e.querySelector('.stat-value').textContent.trim()])));
  assert.strictEqual(stats['Comprado en China'], 'USD 220.00', '10×8 + 10×8 + 5×12');
  assert.strictEqual(stats['Productos'], '3');
  assert.strictEqual(await ui.page.locator('#prov-productos tbody tr').count(), 3);
});

test('los productos sin proveedor se asignan a mano, sin usados ni descatalogados', async () => {
  await ui.page.click('#chip-sin-proveedor');
  const skus = await ui.page.$$eval('#tabla-sin-proveedor tbody tr', trs => trs.map(t => t.cells[1].textContent.trim()));
  assert.deepStrictEqual(skus, ['SINPROV']);
  await ui.page.check('.chk-sin[value="SINPROV"]');
  await ui.page.selectOption('#sin-destino', 'PROV-2');
  await ui.page.click('.asignar-bar button:text("Asignar")');
  await ui.page.waitForSelector('text=Todos los productos activos tienen proveedor asignado');
  assert.deepStrictEqual(ultimoPost('/proveedores?accion=asignar').cuerpo, { proveedor_id: 'PROV-2', skus: ['SINPROV'] });
  // Se deshace para ver el aviso de Compras.
  await ui.page.evaluate(() => { productos.find(p => p.sku === 'SINPROV').proveedor_id = null; compras = {}; });
});

test('la compra recomendada completa lo necesario hasta el mínimo del proveedor', async () => {
  // Se llega desde la ficha del proveedor, que lleva a su tarjeta en 🛒 Compras.
  await ui.page.click('.prov-chip:has-text("Yiwu Trading")');
  await ui.page.click('button:text("Ver compra recomendada")');
  await ui.page.waitForSelector('#compra-PROV-1');
  assert.ok(await ui.page.isVisible('#sec-compras'));
  const card = ui.page.locator('#compra-PROV-1');
  assert.strictEqual(await card.getAttribute('data-estado'), 'ya');
  assert.match(await card.textContent(), /Comprar ya/);

  const fila = async sku => card.locator(`tr[data-sku="${sku}"]`);
  const qty = async sku => Number(await (await fila(sku)).locator('.compra-qty').inputValue());
  // Necesario: 14 × 8 + 6 × 8 = 160. Faltan 140: se suman Baúles (el que antes se queda sin
  // stock, 107 días) hasta que pasa a los gatos, y después un gato rojo.
  assert.strictEqual(await qty('GZ-N'), 14);
  assert.strictEqual(await qty('GZ-R'), 7);
  assert.strictEqual(await qty('BAUL'), 11);
  assert.match(await (await fila('BAUL')).textContent(), /\+11 para el mínimo/);
  assert.strictEqual(await card.locator('.compra-total').textContent(), 'USD 300.00');
  assert.match(await card.locator('.compra-minimo').textContent(), /Llega al mínimo/);

  // Editar una cantidad recalcula el total y avisa cuánto falta.
  await (await fila('BAUL')).locator('.compra-qty').fill('1');
  assert.strictEqual(await card.locator('.compra-total').textContent(), 'USD 180.00');
  assert.match(await card.locator('.compra-minimo').textContent(), /Faltan USD 120\.00/);
  await (await fila('BAUL')).locator('.compra-qty').fill('11');

  // El proveedor sin nada para reponer dice cuándo toca la próxima compra.
  assert.match(await ui.page.textContent('#compra-PROV-2'), /Nada para reponer — próxima compra ~06\/11\/2026/);
  // Y lo que hay que reponer sin proveedor no se pierde de vista.
  assert.match(await ui.page.textContent('#aviso-sin-proveedor'), /1 producto para reponer no tiene proveedor.*SINPROV/s);
});

test('la compra recomendada se convierte en una importación de ese proveedor', async () => {
  await ui.page.click('#compra-PROV-1 button:text("Crear importación con esto")');
  await ui.page.waitForSelector('#modal-nueva.open');
  assert.strictEqual(await ui.page.inputValue('#new-proveedor'), 'PROV-1');
  const items = await ui.page.$$eval('#line-items-body tr', trs => trs.map(t => ({
    sku: t.querySelector('.li-sku').value, qty: t.querySelector('.li-qty').value, costo: t.querySelector('.li-cost').value })));
  assert.deepStrictEqual(items, [
    { sku: 'GZ-N', qty: '14', costo: '8' }, { sku: 'GZ-R', qty: '7', costo: '8' }, { sku: 'BAUL', qty: '11', costo: '12' }]);
  assert.match(await ui.page.textContent('#new-minimo'), /llega al mínimo de Yiwu Trading/);
  await ui.page.click('#modal-nueva button:text("Cancelar")');
});

test('no hubo errores ni alertas inesperadas', () => {
  assert.deepStrictEqual(ui.alertas, []);
  const reales = erroresReales(ui.errores);
  assert.deepStrictEqual(reales, [], 'errores inesperados:\n' + reales.join('\n'));
});

test('sin la migración, la página avisa y la importación se guarda sin proveedor', async () => {
  const estado = estadoBase();
  estado.sinMigracion = true;
  const otro = await abrir('importaciones.html', estado);
  try {
    await otro.page.waitForSelector('#imports-table-container table');
    assert.ok(await otro.page.isVisible('#aviso-migracion'));
    assert.match(await otro.page.textContent('#aviso-migracion'), /20261024000000_add_proveedores\.sql/);
    await otro.page.click('button:text("+ Nueva Importación")');
    await otro.page.fill('#line-items-body .li-sku', 'GZ-N');
    await otro.page.fill('#line-items-body .li-qty', '5');
    await otro.page.fill('#new-total-pagado', '100');
    await otro.page.click('#modal-nueva button:text("Guardar importación")');
    await otro.page.waitForSelector('#modal-nueva.open', { state: 'hidden' });
    assert.deepStrictEqual(otro.alertas, [], 'no exige proveedor si la tabla no existe');
    assert.ok(!('proveedor_id' in estado.posts.find(p => p.ruta === '/importaciones' && p.metodo === 'POST').cuerpo));
    await otro.page.click('#tab-compras');
    await otro.page.waitForSelector('text=se activan cuando corras la migración');
    assert.deepStrictEqual(erroresReales(otro.errores), []);
  } finally {
    await otro.cerrar();
  }
});

test('Reposición separa el hueco sin stock de lo que hay que volver a pedir', async () => {
  const estado = estadoBase();
  const hoy = HOY;
  estado.restock.productos = [{
    sku: 'GZ-N', nombre: 'Gato elevador negro', grupo: 'Soportes', stock: 0, daily_velocity: 0.16, total_sold: 8, active_days: 49,
    days_coverage: 0, restock_status: 'quiebre_confirmado', cantidad_sugerida: 14, punto_pedido_uds: 24, alerta_min: 0,
    already_ordered: true, qty_en_transito: 10, proxima_llegada: '2026-12-12', gap_cierra_fecha: '2026-12-12',
    agota_con_transito: '2027-02-12', en_transito: [{ qty: 10, llegada: '2026-12-12', estado: 'ordered' }], today: hoy,
  }];
  const rep = await abrir('reposicion.html', estado);
  try {
    await rep.page.waitForSelector('#list-container table');
    const celda = await rep.page.textContent('#list-container tbody tr td:last-child');
    assert.match(celda, /Sin stock hasta el 12\/12\/2026/);
    assert.match(celda, /Ese hueco ya no se tapa: una compra nueva tardaría ~85 días/);
    assert.match(celda, /Además, pedí 14 más/);
    assert.match(celda, /Los 10 en camino duran hasta ~12\/02\/2027/);
    assert.match(celda, /hacen falta ~24 uds \(hay 10\)/);
    // 12/02/2027 − 85 días = 19/11/2026
    assert.match(celda, /Pedila antes del ~19\/11\/2026|Ya pasó la fecha para pedir/);
    assert.deepStrictEqual(erroresReales(rep.errores), []);
  } finally {
    await rep.cerrar();
  }
});
