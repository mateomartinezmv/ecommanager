// PATCH /api/productos?sku=XX: descatalogar (o reactivar) sin mandar el producto entero.
//
// Es lo que usa 📅 Reposición para sacar del catálogo lo que la clase de compra marca como
// "descatalogar". Lo que no puede pasar: que toque algo más que el descatalogado. El PUT
// reescribe la fila completa, y mandarle sólo el descatalogado le borraría las publicaciones
// de MELI, el grupo y el stock.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { supabaseMemoria } = require('./fixtures/supabaseMemoria');

let tablas;
const fila = (o = {}) => ({
  sku: 'HP-CB0382', nombre: 'Manillar 28mm', grupo: 'Manillares', subgrupo: 'Universal 7/8', tipo: 'nuevo',
  unidades_por_venta: 1, notas: null, proveedor_id: null,
  stock_dep: 5, stock_meli: 5, stock_shopify: 0, costo: 484, precio: 1490, alerta_min: 3,
  meli_id: 'MLU123', meli_ids: ['MLU123'], shopify_id: null, discontinuado: false,
  motivo_discontinuado: null, nota_discontinuado: null, fecha_discontinuado: null, ...o,
});

require.cache[require.resolve(path.join(__dirname, '../api/_supabase'))] = { exports: { getSupabase: () => supabaseMemoria(tablas) } };
const handler = require('../api/productos');

async function patch(sku, body) {
  const res = { setHeader() {}, status(c) { this.code = c; return this; }, end() {}, json(b) { this.body = b; this.code = this.code || 200; return this; } };
  await handler({ method: 'PATCH', query: { sku }, body }, res);
  return res;
}

beforeEach(() => { tablas = { productos: [fila(), fila({ sku: 'OTRO', nombre: 'Otro' })] }; });

test('descataloga con motivo, aclaración y fecha, sin tocar nada más del producto', async () => {
  const antes = { ...tablas.productos[0] };
  const r = await patch('HP-CB0382', {
    discontinuado: true, motivoDiscontinuado: 'poca_venta',
    notaDiscontinuado: 'Sugerido por Reposición: sin ventas en 68 días', fechaDiscontinuado: '2026-11-18',
  });
  assert.strictEqual(r.code, 200);
  const p = tablas.productos[0];
  assert.strictEqual(p.discontinuado, true);
  assert.strictEqual(p.motivo_discontinuado, 'poca_venta');
  assert.strictEqual(p.nota_discontinuado, 'Sugerido por Reposición: sin ventas en 68 días');
  assert.strictEqual(p.fecha_discontinuado, '2026-11-18');
  for (const c of ['nombre', 'grupo', 'subgrupo', 'tipo', 'stock_dep', 'stock_meli', 'costo', 'precio', 'alerta_min', 'meli_ids', 'meli_id']) {
    assert.deepStrictEqual(p[c], antes[c], `no tiene que tocar ${c}`);
  }
  assert.strictEqual(tablas.productos[1].discontinuado, false, 'el otro producto queda igual');
});

test('reactivar borra el motivo entero', async () => {
  tablas.productos[0] = fila({ discontinuado: true, motivo_discontinuado: 'poca_venta', nota_discontinuado: 'x', fecha_discontinuado: '2026-11-18' });
  await patch('HP-CB0382', { discontinuado: false });
  const p = tablas.productos[0];
  assert.strictEqual(p.discontinuado, false);
  assert.strictEqual(p.motivo_discontinuado, null);
  assert.strictEqual(p.fecha_discontinuado, null);
});

test('sin la migración del motivo, igual descataloga y avisa', async () => {
  const { motivo_discontinuado, nota_discontinuado, fecha_discontinuado, ...sinColumnas } = fila();
  tablas.productos = [sinColumnas];
  const r = await patch('HP-CB0382', { discontinuado: true, motivoDiscontinuado: 'poca_venta' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.migracionMotivoPendiente, true);
  assert.strictEqual(tablas.productos[0].discontinuado, true);
});

test('pide sku y discontinuado; un sku que no existe da 404', async () => {
  assert.strictEqual((await patch('', { discontinuado: true })).code, 400);
  assert.strictEqual((await patch('HP-CB0382', { motivoDiscontinuado: 'poca_venta' })).code, 400);
  const r = await patch('NO-EXISTE', { discontinuado: true });
  assert.strictEqual(r.code, 404);
  assert.match(r.body.error, /No existe el producto NO-EXISTE/);
});

// El formulario de producto (PUT) guarda el proveedor si lo manda, y si no lo manda no lo
// toca: un guardado sin el campo (porque no hay proveedores cargados) no borra el que le
// puso Importaciones.
async function put(sku, body) {
  const res = { setHeader() {}, status(c) { this.code = c; return this; }, end() {}, json(b) { this.body = b; this.code = this.code || 200; return this; } };
  await handler({ method: 'PUT', query: { sku }, body }, res);
  return res;
}
const formulario = (o = {}) => ({
  sku: 'HP-CB0382', nombre: 'Manillar 28mm', grupo: 'Manillares', subgrupo: 'Universal 7/8', tipo: 'nuevo',
  unidadesPorVenta: 1, stockDep: 5, costo: 484, precio: 1490, alertaMin: 3, meliIds: ['MLU123'], shopifyId: '', notas: '', ...o,
});

test('el PUT guarda el proveedor si viene y no lo toca si no viene', async () => {
  tablas.productos[0].proveedor_id = null;
  let r = await put('HP-CB0382', formulario({ proveedorId: 'PROV-HONGPA' }));
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(tablas.productos[0].proveedor_id, 'PROV-HONGPA');

  r = await put('HP-CB0382', formulario());
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(tablas.productos[0].proveedor_id, 'PROV-HONGPA', 'sin el campo, se conserva');

  await put('HP-CB0382', formulario({ proveedorId: null }));
  assert.strictEqual(tablas.productos[0].proveedor_id, null, '"Sin proveedor" lo saca');
});
