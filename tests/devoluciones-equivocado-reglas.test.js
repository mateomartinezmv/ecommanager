// Devolución de un producto equivocado, directo sobre api/devoluciones.js (sin navegador ni
// red): el cliente pidió A (la venta), le mandamos B y devuelve B. El correcto se le reenvía
// sin cargar otra venta, así que A no se toca nunca y el stock que se mueve es el de B:
// −cantidad al registrar, +cantidad al confirmar, +cantidad si se borra estando pendiente.
//
// Supabase y la sincronización de stock (que publicaría en MELI y Shopify) se reemplazan por
// versiones en memoria antes de cargar el handler.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { skuDeStock, faltaMigracionSkuRecibido } = require('../api/_devoluciones');

function supabaseFalso(db, { sinColumna = false } = {}) {
  const ejecutar = q => {
    const tabla = db[q.tabla] = db[q.tabla] || [];
    const pasa = r => q.filtros.every(f => f(r));
    if (q.fila && sinColumna && 'sku_recibido' in q.fila) {
      return { data: null, error: { code: 'PGRST204', message: `Could not find the 'sku_recibido' column of '${q.tabla}' in the schema cache` } };
    }
    let filas;
    if (q.op === 'insert') { tabla.push({ ...q.fila }); filas = [tabla[tabla.length - 1]]; }
    else if (q.op === 'update') { filas = tabla.filter(pasa); filas.forEach(r => Object.assign(r, q.fila)); }
    else if (q.op === 'delete') { filas = tabla.filter(pasa); db[q.tabla] = tabla.filter(r => !pasa(r)); }
    else filas = tabla.filter(pasa);
    if (q.single && !filas[0]) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return { data: q.single ? { ...filas[0] } : filas.map(r => ({ ...r })), error: null };
  };
  return {
    from(tabla) {
      const q = { tabla, op: 'select', filtros: [], fila: null, single: false };
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => { q.filtros.push(r => r[c] === v); return b; },
        insert: f => { q.op = 'insert'; q.fila = f; return b; },
        update: f => { q.op = 'update'; q.fila = f; return b; },
        delete: () => { q.op = 'delete'; return b; },
        single: () => { q.single = true; return b; },
        then: (ok, ko) => Promise.resolve(ejecutar(q)).then(ok, ko),
      };
      return b;
    },
  };
}

// La sincronización de stock en memoria: mueve stock_dep del producto de la base falsa y
// anota cada movimiento. `fallarDescuento` imita el RPC que no pudo descontar.
let db = null;
let movimientos = [];
let fallarDescuento = false;
const producto = sku => db.productos.find(p => p.sku === sku);
require.cache[require.resolve(path.join(__dirname, '../api/_stockSync'))] = {
  exports: {
    resumenSync: () => '',
    sincronizarStock: async (_s, p, nuevo) => {
      movimientos.push({ sku: p.sku, op: 'fijar', valor: nuevo });
      producto(p.sku).stock_dep = nuevo;
      return { stockDep: nuevo, error: null };
    },
    descontarStock: async (_s, p, unidades) => {
      if (fallarDescuento) return { stockDep: p.stock_dep, error: 'rpc caída' };
      movimientos.push({ sku: p.sku, op: 'descontar', valor: unidades });
      producto(p.sku).stock_dep = Math.max(0, producto(p.sku).stock_dep - unidades);
      return { stockDep: producto(p.sku).stock_dep, error: null };
    },
  },
};
let supabaseActual = null;
require.cache[require.resolve(path.join(__dirname, '../api/_supabase'))] = {
  exports: { getSupabase: () => supabaseActual },
};
const handler = require('../api/devoluciones');

async function llamar({ method, query = {}, body }) {
  const res = {
    code: 200, body: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query, body }, res);
  return res;
}

function base(opciones) {
  db = {
    productos: [
      { sku: 'A', nombre: 'Slider negro', stock_dep: 10, unidades_por_venta: 1 },
      { sku: 'B', nombre: 'Slider rojo', stock_dep: 5, unidades_por_venta: 1 },
      { sku: 'PAR', nombre: 'Sliders de a par', stock_dep: 8, unidades_por_venta: 2 },
    ],
  };
  movimientos = [];
  fallarDescuento = false;
  supabaseActual = supabaseFalso(db, opciones);
}
const stock = sku => producto(sku).stock_dep;
const registrar = (extra = {}) => llamar({ method: 'POST',
  body: { ventaId: 'V-1', sku: 'A', producto: 'Slider negro', cantidad: 1, skuRecibido: 'B', ...extra } });

test('skuDeStock: el equivocado si lo hay, si no el de la venta', () => {
  assert.strictEqual(skuDeStock({ sku: 'A', sku_recibido: 'B' }), 'B');
  assert.strictEqual(skuDeStock({ sku: 'A', sku_recibido: null }), 'A');
  assert.ok(faltaMigracionSkuRecibido({ code: 'PGRST204', message: "Could not find the 'sku_recibido' column" }));
  assert.ok(!faltaMigracionSkuRecibido({ code: 'PGRST204', message: "Could not find the 'costo_envio' column" }));
});

test('registrar descuenta B (está en lo del cliente) y guarda qué recibió; A no se toca', async () => {
  base();
  const r = await registrar();
  assert.strictEqual(r.code, 200);
  assert.strictEqual(stock('B'), 4);
  assert.strictEqual(stock('A'), 10);
  const dev = db.devoluciones[0];
  assert.deepStrictEqual([dev.sku, dev.sku_recibido, dev.producto_recibido, dev.estado], ['A', 'B', 'Slider rojo', 'pendiente']);
  assert.strictEqual(r.body.stockRecibido, 4);
});

test('confirmar suma a B, no a A: B queda como antes del error', async () => {
  base();
  await registrar();
  const r = await llamar({ method: 'PUT', query: { id: db.devoluciones[0].id } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.skuRepuesto, 'B');
  assert.strictEqual(stock('B'), 5);
  assert.strictEqual(stock('A'), 10);
  assert.ok(movimientos.every(m => m.sku === 'B'), 'sólo se movió B: ' + JSON.stringify(movimientos));
});

test('borrar una pendiente le devuelve a B lo descontado; una recibida no toca nada', async () => {
  base();
  await registrar();
  const r = await llamar({ method: 'DELETE', query: { id: db.devoluciones[0].id } });
  assert.strictEqual(r.body.skuRepuesto, 'B');
  assert.strictEqual(stock('B'), 5);
  assert.strictEqual(db.devoluciones.length, 0);

  await registrar();
  await llamar({ method: 'PUT', query: { id: db.devoluciones[0].id } });
  movimientos = [];
  await llamar({ method: 'DELETE', query: { id: db.devoluciones[0].id } });
  assert.deepStrictEqual(movimientos, []);
  assert.strictEqual(stock('B'), 5);
});

test('una devolución común sigue igual: no mueve stock al registrar y suma a A al confirmar', async () => {
  base();
  await registrar({ skuRecibido: undefined });
  assert.deepStrictEqual(movimientos, []);
  await llamar({ method: 'PUT', query: { id: db.devoluciones[0].id } });
  assert.strictEqual(stock('A'), 11);
  assert.strictEqual(stock('B'), 5);
});

test('un pack equivocado mueve las unidades del pack', async () => {
  base();
  await registrar({ skuRecibido: 'PAR' });
  assert.strictEqual(stock('PAR'), 6, 'un par son 2 unidades de depósito');
  await llamar({ method: 'PUT', query: { id: db.devoluciones[0].id } });
  assert.strictEqual(stock('PAR'), 8);
});

test('se rechaza el mismo SKU que pidió y un SKU que no existe, sin tocar nada', async () => {
  base();
  assert.strictEqual((await registrar({ skuRecibido: 'A' })).code, 400);
  const r = await registrar({ skuRecibido: 'NOEXISTE' });
  assert.strictEqual(r.code, 400);
  assert.match(r.body.error, /NOEXISTE/);
  assert.strictEqual((db.devoluciones || []).length, 0);
  assert.deepStrictEqual(movimientos, []);
});

test('sin la migración no se registra (y no se descuenta nada)', async () => {
  base({ sinColumna: true });
  const r = await registrar();
  assert.strictEqual(r.code, 503);
  assert.match(r.body.error, /20261105000000_add_sku_recibido_devoluciones\.sql/);
  assert.strictEqual((db.devoluciones || []).length, 0);
  assert.strictEqual(stock('B'), 5);
});

test('si no se pudo descontar B, la devolución no queda registrada', async () => {
  base();
  fallarDescuento = true;
  const r = await registrar();
  assert.strictEqual(r.code, 500);
  assert.match(r.body.error, /No se pudo descontar el stock de B/);
  assert.strictEqual(db.devoluciones.length, 0);
});
