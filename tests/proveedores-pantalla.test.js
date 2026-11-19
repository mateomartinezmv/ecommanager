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
const CI = require('../public/costo-importacion');

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
      // Sin ventas ni reposición: sólo está para reconocer el baúl de 45L por el SKU.
      { sku: 'BAUL45', nombre: 'Baúl Trasero Moto 45L PP Alta Resistencia', tipo: 'nuevo', stock_dep: 5, proveedor_id: 'PROV-2' },
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

    // PATCH: descatalogar desde Reposición. Como la API, el producto sale de /restock.
    if (ruta === '/productos' && metodo === 'PATCH') {
      const sku = url.searchParams.get('sku');
      const prod = estado.productos.find(p => p.sku === sku);
      if (prod) prod.discontinuado = cuerpo.discontinuado;
      if (cuerpo.discontinuado && estado.restock?.productos) {
        estado.restock.productos = estado.restock.productos.filter(p => p.sku !== sku);
      }
      return ok({ sku, discontinuado: cuerpo.discontinuado });
    }
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
        // Como la API: con puesta en puerto el total y los montos de los pagos salen de los costos.
        if (CI.esPuerto(imp)) Object.assign(imp, { total: CI.totales(imp).total, pagos: CI.armarPagos(imp, cuerpo.pagos) });
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
        if (CI.esPuerto(imp)) Object.assign(imp, { total: CI.totales(imp).total, pagos: CI.armarPagos(imp, cuerpo.pagos ?? imp.pagos) });
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
  // CHROMIUM_PATH: igual que en helpers.js, para una máquina con otro Chromium instalado.
  const browser = await chromium.launch({ args: ['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
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
  await ui.page.fill('#new-allin', '100');
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
  // El modal se cierra antes de que la página relea los productos: se espera a que la tabla
  // se redibuje para que la limpieza de abajo no la pise esa relectura.
  await ui.page.waitForSelector('tr[data-id="IMP-NUEVA"]');
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
  // El baúl de esta compra es de 28L: factor normal.
  assert.match(await card.locator('.compra-uy').textContent(), /Costo puesto en Uruguay estimado: USD 750\.00 \(costo en China ×2\.5\)/);

  // Editar una cantidad recalcula el total y avisa cuánto falta.
  await (await fila('BAUL')).locator('.compra-qty').fill('1');
  assert.strictEqual(await card.locator('.compra-total').textContent(), 'USD 180.00');
  assert.match(await card.locator('.compra-minimo').textContent(), /Faltan USD 120\.00/);
  assert.match(await card.locator('.compra-uy').textContent(), /USD 450\.00/, 'se recalcula con la cantidad editada');
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

test('el costo puesto en Uruguay es ×2.5, o ×3 si la importación trae baúles de 45L', async () => {
  await ui.page.click('button:text("+ Nueva Importación")');
  await ui.page.waitForSelector('#modal-nueva.open');
  const fila = ui.page.locator('#line-items-body tr').first();
  await fila.locator('.li-sku').fill('GZ-N');
  await fila.locator('.li-qty').fill('2');
  await fila.locator('.li-cost').fill('10');
  assert.match(await ui.page.textContent('#new-uy'), /USD 50\.00 \(costo en China ×2\.5\)/);

  // Reconocido por el nombre del renglón…
  await ui.page.click('#modal-nueva button:text("+ Agregar ítem")');
  const otra = ui.page.locator('#line-items-body tr').nth(1);
  await otra.locator('.li-name').fill('Baúl Trasero Moto 45L');
  await otra.locator('.li-qty').fill('1');
  await otra.locator('.li-cost').fill('10');
  assert.match(await ui.page.textContent('#new-uy'), /USD 90\.00 \(costo en China ×3 — lleva baúles de 45L/, '30 × 3');

  // …y por el SKU, cuando el renglón no tiene nombre.
  await otra.locator('.li-name').fill('');
  await otra.locator('.li-sku').fill('BAUL45');
  assert.match(await ui.page.textContent('#new-uy'), /USD 90\.00 \(costo en China ×3/);

  // Un baúl de otro tamaño no cuenta.
  await otra.locator('.li-sku').fill('');
  await otra.locator('.li-name').fill('Baúl Trasero Moto 28L');
  assert.match(await ui.page.textContent('#new-uy'), /USD 75\.00 \(costo en China ×2\.5\)/);
  await ui.page.click('#modal-nueva button:text("Cancelar")');
});

test('una importación con puesta en puerto calcula el factor, los tres pagos y el costo por unidad', async () => {
  await ui.page.click('#tab-importaciones');
  await ui.page.click('button:text("+ Nueva Importación")');
  await ui.page.waitForSelector('#modal-nueva.open');
  assert.strictEqual(await ui.page.inputValue('#new-importador'), 'GrupoRAS', 'el importador viene sugerido');
  await ui.page.selectOption('#new-proveedor', 'PROV-1');
  await ui.page.fill('#new-order-date', '2026-11-11');
  await ui.page.fill('#new-est-arrival', '2027-01-20');
  await ui.page.dispatchEvent('#new-est-arrival', 'change');
  await ui.page.fill('#line-items-body .li-sku', 'GZ-N');
  await ui.page.fill('#line-items-body .li-qty', '10');
  await ui.page.fill('#line-items-body .li-cost', '12');
  await ui.page.click('#modal-nueva button:text("+ Agregar ítem")');
  const fila2 = ui.page.locator('#line-items-body tr').nth(1);
  await fila2.locator('.li-sku').fill('GZ-R');
  await fila2.locator('.li-qty').fill('5');
  await fila2.locator('.li-cost').fill('16');
  // China = 120 + 80 = 200. Sin puesta en puerto todavía no hay factor.
  assert.match(await ui.page.textContent('#new-totales'), /Cargá el all in del importador/);
  await ui.page.fill('#new-allin', '70');
  assert.match(await ui.page.textContent('#new-factor'), /×1,35 \+35,0% sobre China/);
  assert.doesNotMatch(await ui.page.textContent('#new-totales'), /Otros gastos/, 'sin otros gastos no se muestra la fila');
  await ui.page.fill('#new-nacional', '30');
  assert.match(await ui.page.textContent('#new-factor'), /×1,50/);
  assert.match(await ui.page.textContent('#new-total'), /USD 300\.00/);

  const pagos = await ui.page.$$eval('#new-pagos .pago-row', rs => rs.map(r => [r.querySelector('.pago-monto-input').value, r.querySelector('.pago-estimado').value]));
  assert.deepStrictEqual(pagos, [['100', '2026-11-11'], ['100', '2026-11-21'], ['100', '2027-01-20']]);
  await ui.page.check('#new-pagos .pago-row[data-id="anticipo"] .pago-check');

  // El monto de un pago se edita a mano: queda marcado, avisa la diferencia y se puede volver.
  const monto2 = '#new-pagos .pago-row[data-id="saldo_proveedor"] .pago-monto-input';
  await ui.page.fill(monto2, '115');
  await ui.page.dispatchEvent(monto2, 'change');
  assert.match(await ui.page.textContent('#new-pagos-dif'), /Los pagos suman USD 315\.00 y el costo total es USD 300\.00 \(\+USD 15\.00\)/);
  assert.match(await ui.page.textContent('#new-pagos .pago-row[data-id="saldo_proveedor"]'), /calculado USD 100\.00 ↺/);
  await ui.page.fill('#new-traslado', '0');   // otro recálculo no pisa lo editado
  assert.strictEqual(await ui.page.inputValue(monto2), '115');
  await ui.page.click('#new-pagos .pago-row[data-id="saldo_proveedor"] .pago-reset');
  assert.strictEqual(await ui.page.inputValue(monto2), '100');
  assert.strictEqual(await ui.page.textContent('#new-pagos-dif'), '');
  await ui.page.fill(monto2, '120');
  await ui.page.dispatchEvent(monto2, 'change');

  // La comisión de Alibaba de un pago suma al costo total.
  const fee1 = '#new-pagos .pago-row[data-id="anticipo"] .pago-fee-input';
  await ui.page.fill(fee1, '6');
  await ui.page.dispatchEvent(fee1, 'change');
  assert.match(await ui.page.textContent('#new-totales'), /Comisiones de pago \(Alibaba, banco\)\s*USD 6\.00/);
  assert.match(await ui.page.textContent('#new-total'), /USD 306\.00/);
  assert.match(await ui.page.textContent('#new-factor'), /×1,53/);
  await ui.page.fill(fee1, '');
  await ui.page.dispatchEvent(fee1, 'change');

  await ui.page.click('#modal-nueva button:text("Guardar importación")');
  await ui.page.waitForSelector('tr[data-id="IMP-NUEVA"]');
  const post = ultimoPost('/importaciones');
  assert.strictEqual(post.cuerpo.importador, 'GrupoRAS');
  assert.strictEqual(post.cuerpo.costo_puerto, 270);
  assert.strictEqual(post.cuerpo.nacional, 30);
  assert.strictEqual(post.cuerpo.cotizacion_usd, 40);
  assert.ok(!('total' in post.cuerpo), 'ya no se manda un total con IVA');
  assert.deepStrictEqual(post.cuerpo.pagos.map(p => [p.id, p.pagado, p.monto, p.monto_manual]),
    [['anticipo', true, 100, false], ['saldo_proveedor', false, 120, true], ['puerto', false, 100, false]]);

  const fila = 'tr[data-id="IMP-NUEVA"]';
  assert.strictEqual((await ui.page.textContent(`${fila} .celda-factor`)).trim(), '×1,50');
  assert.match(await ui.page.textContent(`${fila} .celda-pagos`), /Próximo: USD 120\.00 · 21\/11\/2026/);
  await ui.page.click(`${fila} .pago-chip[data-pago="saldo_proveedor"]`);
  await ui.page.waitForSelector(`${fila} .pago-chip.ok[data-pago="saldo_proveedor"]`);
  assert.deepStrictEqual(ultimoPost('/importaciones?id=IMP-NUEVA', 'PUT').cuerpo.pagos.map(p => p.pagado), [true, true, false]);

  await ui.page.click(`${fila} button:text("📋 Ver")`);
  await ui.page.waitForSelector('#detalle-costos');
  const unit = await ui.page.$$eval('#detalle-costos tbody tr', trs => trs.map(t => [...t.cells].slice(2, 5).map(c => c.textContent.trim())));
  assert.deepStrictEqual(unit, [['USD 12.00', 'USD 18.00', '$720,00'], ['USD 16.00', 'USD 24.00', '$960,00']]);
  await ui.page.click('#modal-detalle button:text("Cerrar")');

  ui.estado.importaciones.shift();
  ui.estado.productos.filter(p => ['GZ-N', 'GZ-R'].includes(p.sku)).forEach(p => { p.proveedor_id = 'PROV-1'; });
  await ui.page.evaluate(() => { imports.shift(); compras = {}; renderTodo(); });
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
    await otro.page.fill('#new-allin', '100');
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

// ── Clase de compra (api/_clasesCompra.js) ──────────────────────────────────────
function restockConClases() {
  const base = { grupo: 'Espejos', unidades_por_venta: 1, alerta_min: 0, en_transito: [], today: HOY, periodos_sin_stock: [] };
  return {
    lead_time_promedio: 85,
    clases_colchon_dias: { nunca: 55, siempre: 25, poco: 0 },
    clases: {
      nunca:        { productos: 1, contrib_pct: 54, compra_pct: 32, reparto_pct: 35, valor_stock: 3420 },
      siempre:      { productos: 0, contrib_pct: 25, compra_pct: 32, reparto_pct: 45, valor_stock: 0 },
      nuevo:        { productos: 1, contrib_pct: 13, compra_pct: 13, reparto_pct: 15, valor_stock: 1000 },
      poco:         { productos: 1, contrib_pct: 8,  compra_pct: 21, reparto_pct: 5,  valor_stock: 668 },
      descatalogar: { productos: 1, contrib_pct: 0,  compra_pct: 1,  reparto_pct: 0,  valor_stock: 2420 },
    },
    productos: [
      { ...base, sku: 'ALERON', nombre: 'Espejo alerón grande', proveedor_id: 'PROV-1', costo: 342, stock: 10, daily_velocity: 0.88, total_sold: 131, active_days: 149,
        days_coverage: 11, restock_status: 'ordenar_ya', restock_date: '2026-01-01', stockout_date: '2026-01-01',
        cantidad_sugerida: 114, punto_pedido_uds: 100, objetivo_uds: 124, already_ordered: false, qty_en_transito: 0,
        clase: 'nunca', contrib_mes: 21816, retorno_100: 242, ads_pct: 10, ads_estimado: false,
        clase_motivo: 'Deja ~$21.816 por mes después de Ads y $242 por cada $100 de costo: de los que más dejan.' },
      { ...base, sku: 'CIRC', nombre: 'Espejos circulares', proveedor_id: 'PROV-1', costo: 334, stock: 2, daily_velocity: 0.2, total_sold: 30, active_days: 150,
        days_coverage: 10, restock_status: 'cubierto', cantidad_sugerida: 0, punto_pedido_uds: 20, objetivo_uds: 17,
        already_ordered: false, qty_en_transito: 0, valor_stock: 668, motivo_sugerido: 'poco_margen',
        clase: 'poco', contrib_mes: 39, retorno_100: 2, ads_pct: 54, ads_estimado: false,
        clase_motivo: 'Sin publicidad dejaría $155 por cada $100 de costo, pero los Ads (54% de lo que factura en MELI) le dejan $2.' },
      { ...base, sku: 'MAN28', nombre: 'Manillar 28 mm', grupo: 'Manillares', proveedor_id: 'PROV-2', stock: 5, daily_velocity: 0, total_sold: 0,
        days_coverage: null, restock_status: 'no_comprar', cantidad_sugerida: 0, punto_pedido_uds: 0, objetivo_uds: 0,
        already_ordered: false, qty_en_transito: 0, valor_stock: 2420, clase: 'descatalogar', contrib_mes: null, retorno_100: null,
        motivo_sugerido: 'poca_venta',
        clase_motivo: 'Sin ventas en 68 días con stock y tenés $2.420 parados en 5 unidades: liquidalo (kit, promo o mostrador) y no lo vuelvas a pedir.' },
      { ...base, sku: 'NUEVO', nombre: 'Producto nuevo', stock: 10, daily_velocity: 0.2, total_sold: 2, active_days: 14,
        days_coverage: 50, restock_status: 'cubierto', cantidad_sugerida: 0, punto_pedido_uds: 5, objetivo_uds: 5,
        already_ordered: false, qty_en_transito: 0, clase: 'nuevo', contrib_mes: 900, retorno_100: 150,
        clase_motivo: 'Poca historia (2 vendidas en 14 días con stock): comprá lotes de prueba hasta confirmar.' },
    ],
  };
}

test('Reposición muestra la clase de cada producto, el resumen y lo que conviene descatalogar', async () => {
  const estado = estadoBase();
  estado.restock = restockConClases();
  const rep = await abrir('reposicion.html', estado);
  try {
    await rep.page.waitForSelector('#list-container table');
    // Resumen: una tarjeta por clase, con la meta en meses con el plazo real (85 + 55 días).
    const nunca = await rep.page.textContent('.clase-card[data-clase="nunca"]');
    assert.match(nunca, /⭐ Nunca sin stock/);
    assert.match(nunca, /Dejan el 54% de la contribución/);
    assert.match(nunca, /Guía: ~35% de cada compra/);
    assert.match(nunca, /Meta: ~4,7 meses de venta entre stock y en camino/);
    assert.match(await rep.page.textContent('.clase-card[data-clase="descatalogar"]'), /\$2\.420 parados en stock/);
    assert.match(await rep.page.textContent('.clase-card[data-clase="poco"]'), /Solo lo justo para el plazo \(~2,8 meses\), sin colchón/);

    // "Hay que comprar": el descatalogado no aparece aunque tenga stock y piso.
    const skus = async () => rep.page.$$eval('#list-container tbody tr', trs => trs.map(t => t.cells[0].textContent.trim()));
    assert.deepStrictEqual(await skus(), ['ALERON']);
    const fila = await rep.page.textContent('#list-container tbody tr');
    assert.match(fila, /⭐ Nunca sin stock/);
    assert.match(fila, /Deja ~\$21\.816 por mes después de Ads y \$242 por cada \$100 de costo: de los que más dejan/);
    assert.match(fila, /Es de los que nunca pueden quedar sin stock: la meta es ~4,7 meses de venta entre stock y en camino, ~124 uds \(hay 10\)/);

    // La solapa de revisar: descatalogar primero, después comprar poco, cada uno con su motivo.
    await rep.page.click('#seg-revisar');
    assert.deepStrictEqual(await skus(), ['MAN28', 'CIRC']);
    assert.strictEqual((await rep.page.textContent('#seg-count-revisar')).trim(), '2');
    const filas = await rep.page.$$eval('#list-container tbody tr', trs => trs.map(t => t.textContent));
    assert.match(filas[0], /⛔ Descatalogar/);
    assert.match(filas[0], /⛔ No volver a comprar/);
    assert.match(filas[0], /\$2\.420 parados en 5 unidades/);
    assert.match(filas[1], /🔻 Comprar poco/);
    assert.match(filas[1], /los Ads \(54% de lo que factura en MELI\)/);
    assert.match(filas[1], /deja \$39\/mes · \$2 por \$100 · Ads 54%/);

    // Cada tarjeta filtra la lista por su clase (y vuelve a tocarla saca el filtro).
    await rep.page.click('#seg-todos');
    await rep.page.click('.clase-card[data-clase="nuevo"]');
    assert.deepStrictEqual(await skus(), ['NUEVO']);
    assert.strictEqual(await rep.page.inputValue('#filter-clase'), 'nuevo');
    await rep.page.click('.clase-card[data-clase="nuevo"]');
    assert.strictEqual((await skus()).length, 4);
    assert.deepStrictEqual(erroresReales(rep.errores), []);
  } finally {
    await rep.cerrar();
  }
});

test('la compra por proveedor rellena primero a los ⭐ y nunca a los de comprar poco', async () => {
  const estado = estadoBase();
  const clases = { 'GZ-N': 'nunca', 'GZ-R': 'siempre', BAUL: 'poco' };
  estado.restock.productos.forEach(p => { p.clase = clases[p.sku] || null; });
  const otro = await abrir('importaciones.html', estado);
  try {
    await otro.page.waitForSelector('#imports-table-container table');
    await otro.page.click('#tab-compras');
    await otro.page.waitForSelector('#compra-PROV-1');
    const card = otro.page.locator('#compra-PROV-1');
    const qty = async sku => Number(await card.locator(`tr[data-sku="${sku}"] .compra-qty`).inputValue());
    // Necesario 14 + 6 gatos. El relleno va primero al gato negro (⭐) hasta 180 días de
    // venta, después al rojo; el baúl de 28L (comprar poco) no recibe nada.
    assert.strictEqual(await qty('GZ-N'), 19);
    assert.strictEqual(await qty('GZ-R'), 13);
    assert.strictEqual(await qty('BAUL'), 0);
    assert.match(await card.locator('tr[data-sku="GZ-N"]').textContent(), /⭐/);
    assert.deepStrictEqual(erroresReales(otro.errores), []);
  } finally {
    await otro.cerrar();
  }
});

test('desde Reposición se descataloga uno (clic en el badge) o todos los sugeridos', async () => {
  const estado = estadoBase();
  estado.restock = restockConClases();
  const rep = await abrir('reposicion.html', estado);
  try {
    await rep.page.waitForSelector('#list-container table');
    const skus = async () => rep.page.$$eval('#list-container tbody tr', trs => trs.map(t => t.cells[0].textContent.trim()));
    // En "Hay que comprar" no hay sugeridos para descatalogar: no aparece el botón.
    assert.ok(await rep.page.isHidden('#btn-desc-sugeridos'));
    await rep.page.click('#seg-revisar');
    assert.strictEqual((await rep.page.textContent('#btn-desc-sugeridos')).trim(), '⛔ Descatalogar el sugerido');

    // Clic en el badge de uno de "comprar poco": abre el formulario con su motivo sugerido.
    await rep.page.click('tr:has-text("Espejos circulares") button.badge-accion');
    await rep.page.waitForSelector('#modal-desc.abierto');
    assert.strictEqual(await rep.page.textContent('#desc-titulo'), '⛔ Descatalogar producto');
    assert.strictEqual(await rep.page.inputValue('#desc-lista .desc-fila[data-sku="CIRC"] .desc-motivo'), 'poco_margen');
    await rep.page.keyboard.press('Escape');
    assert.ok(await rep.page.isHidden('#modal-desc'));

    // Todos los sugeridos de una vez: va el PATCH con el motivo y el porqué de Reposición.
    await rep.page.click('#btn-desc-sugeridos');
    await rep.page.waitForSelector('#modal-desc.abierto');
    assert.deepStrictEqual(await rep.page.$$eval('#desc-lista .desc-fila', fs => fs.map(f => f.dataset.sku)), ['MAN28']);
    assert.strictEqual(await rep.page.inputValue('.desc-fila[data-sku="MAN28"] .desc-motivo'), 'poca_venta');
    assert.strictEqual(await rep.page.textContent('#desc-guardar'), '⛔ Descatalogar');
    await rep.page.click('#desc-guardar');
    await rep.page.waitForSelector('.aviso-ok');
    const patch = estado.posts.find(p => p.metodo === 'PATCH');
    assert.strictEqual(patch.ruta, '/productos?sku=MAN28');
    assert.strictEqual(patch.cuerpo.discontinuado, true);
    assert.strictEqual(patch.cuerpo.motivoDiscontinuado, 'poca_venta');
    assert.match(patch.cuerpo.notaDiscontinuado, /^Sugerido por Reposición: Sin ventas en 68 días con stock/);
    assert.match(patch.cuerpo.fechaDiscontinuado, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(await rep.page.textContent('#aviso-reposicion'), /MAN28 quedó descatalogado.*Stock → ♻️/);
    // Sale de la lista y, sin sugeridos, se va el botón.
    await rep.page.waitForFunction(() => ![...document.querySelectorAll('#list-container tbody tr')].some(t => t.textContent.includes('MAN28')));
    assert.deepStrictEqual(await skus(), ['CIRC']);
    assert.ok(await rep.page.isHidden('#btn-desc-sugeridos'));
    assert.deepStrictEqual(erroresReales(rep.errores), []);
    assert.deepStrictEqual(rep.alertas, []);
  } finally {
    await rep.cerrar();
  }
});

test('Reposición filtra por proveedor y dice qué pedirle, con acceso a su compra armada', async () => {
  const estado = estadoBase();
  estado.restock = restockConClases();
  const rep = await abrir('reposicion.html', estado);
  try {
    await rep.page.waitForSelector('#list-container table');
    const skus = async () => rep.page.$$eval('#list-container tbody tr', trs => trs.map(t => t.cells[0].textContent.trim()));
    // Solo los proveedores que tienen productos en Reposición, más "Sin proveedor".
    const opciones = await rep.page.$$eval('#filter-prov option', os => os.map(o => o.textContent.trim()));
    assert.deepStrictEqual(opciones, ['Todos los proveedores', '🏭 Guangzhou Moto (1)', '🏭 Yiwu Trading (2)', 'Sin proveedor (1)']);

    await rep.page.selectOption('#filter-prov', 'PROV-1');
    const panel = await rep.page.textContent('#compra-prov');
    assert.match(panel, /Compra a Yiwu Trading/);
    // ALERON: 114 a $342. CIRC está cubierto: no suma.
    assert.match(panel, /1 producto para pedir \(1 ⭐\) · 114 unidades · ~\$38\.988 a costo puesto/);
    assert.match(panel, /su mínimo es USD 300/);
    assert.strictEqual(await rep.page.getAttribute('#compra-prov a', 'href'), '/importaciones.html#compras=PROV-1');
    assert.deepStrictEqual(await skus(), ['ALERON']);
    await rep.page.click('#seg-todos');
    assert.deepStrictEqual(await skus(), ['ALERON', 'CIRC']);

    // Sin proveedor: lo que falta asignar.
    await rep.page.selectOption('#filter-prov', '__sin');
    assert.deepStrictEqual(await skus(), ['NUEVO']);
    assert.match(await rep.page.textContent('#compra-prov'), /Productos sin proveedor/);

    // La elección queda guardada para la próxima vez.
    await rep.page.selectOption('#filter-prov', 'PROV-2');
    await rep.page.reload();
    // A Guangzhou no hay nada que pedirle: la lista queda vacía y el panel lo dice.
    await rep.page.waitForSelector('#compra-prov .compra-prov');
    assert.strictEqual(await rep.page.inputValue('#filter-prov'), 'PROV-2');
    assert.match(await rep.page.textContent('#list-container'), /No hay productos que necesiten compra urgente/);
    assert.match(await rep.page.textContent('#compra-prov'), /Compra a Guangzhou Moto.*Nada para pedirle ahora/s);
    assert.deepStrictEqual(erroresReales(rep.errores), []);
  } finally {
    await rep.cerrar();
  }
});

test('Importaciones: #compras=PROV abre la compra de ese proveedor', async () => {
  const imp = await abrir('importaciones.html#compras=PROV-1', estadoBase());
  try {
    await imp.page.waitForSelector('#compra-PROV-1');
    assert.ok(await imp.page.isVisible('#sec-compras'));
    assert.deepStrictEqual(erroresReales(imp.errores), []);
  } finally {
    await imp.cerrar();
  }
});

test('la compra por proveedor usa el costo cargado en el producto, aunque no haya importación', async () => {
  const estado = estadoBase();
  // Manillar 22 mm: nunca vino en una importación, pero tiene costo cargado ($484 puesto).
  estado.productos.push({ sku: 'MAN22', nombre: 'Manillar 22mm Rojo', tipo: 'nuevo', stock_dep: 0, proveedor_id: 'PROV-1', costo: 484 });
  estado.restock.productos.push({ sku: 'MAN22', nombre: 'Manillar 22mm Rojo', stock: 0, qty_en_transito: 0, daily_velocity: 0.21,
    unidades_por_venta: 1, cantidad_sugerida: 27, restock_status: 'ordenar_ya', clase: 'nuevo' });
  // Gato negro: el costo cargado ($1.000) le gana al de la última importación (USD 8).
  estado.productos.find(p => p.sku === 'GZ-N').costo = 1000;
  const imp = await abrir('importaciones.html#compras=PROV-1', estado);
  try {
    await imp.page.waitForSelector('#compra-PROV-1');
    const card = imp.page.locator('#compra-PROV-1');
    const costo = async sku => (await card.locator(`tr[data-sku="${sku}"] td`).nth(7).textContent()).trim();
    // $484 ÷ 40 ÷ 2,5 = USD 4.84; $1.000 ÷ 40 ÷ 2,5 = USD 10.00.
    assert.match(await costo('MAN22'), /USD 4\.84\s*de \$484 cargado/);
    assert.match(await costo('GZ-N'), /USD 10\.00\s*de \$1\.000 cargado/);
    // Sin costo cargado, sigue el de la última importación.
    assert.match(await costo('GZ-R'), /USD 8\.00\s*de la última importación/);
    assert.match(await card.locator('tr[data-sku="MAN22"] .compra-sub').textContent(), /USD 130\.68/); // 27 × 4,84
    assert.deepStrictEqual(erroresReales(imp.errores), []);
  } finally {
    await imp.cerrar();
  }
});
