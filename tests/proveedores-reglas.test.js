// Las reglas de proveedores que no pasan por la pantalla, sin navegador: qué se guarda de cada
// proveedor, a qué proveedor queda asignado cada producto según sus importaciones, y qué hace
// /api/importaciones con el proveedor (incluido el estado en el que la migración todavía no
// corrió). La base es un Supabase falso en memoria.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  normalizarProveedor, faltaMigracionProveedores, proveedorPorSku, sincronizarProveedorProductos,
} = require('../api/_proveedores');

// ── Supabase falso ───────────────────────────────────────────────────────────
// Lo justo para las consultas de estos endpoints. `sinColumna` imita una base donde la
// migración no corrió: cualquier write con proveedor_id falla como falla PostgREST.
function supabaseFalso(db, { sinColumna = false } = {}) {
  const writes = [];
  const ejecutar = q => {
    const tabla = db[q.tabla] = db[q.tabla] || [];
    const pasa = r => q.filtros.every(f => f(r));
    if (q.fila && sinColumna && 'proveedor_id' in q.fila) {
      return { data: null, error: { code: 'PGRST204', message: `Could not find the 'proveedor_id' column of '${q.tabla}' in the schema cache` } };
    }
    let filas;
    if (q.op === 'insert') { tabla.push({ ...q.fila }); filas = [tabla[tabla.length - 1]]; writes.push({ tabla: q.tabla, op: 'insert', fila: q.fila }); }
    else if (q.op === 'update') { filas = tabla.filter(pasa); filas.forEach(r => Object.assign(r, q.fila)); writes.push({ tabla: q.tabla, op: 'update', fila: q.fila, filas: filas.map(r => r.sku || r.id) }); }
    else filas = tabla.filter(pasa);
    return { data: q.single ? (filas[0] ? { ...filas[0] } : null) : filas.map(r => ({ ...r })), error: null };
  };
  return {
    writes,
    from(tabla) {
      const q = { tabla, op: 'select', filtros: [], fila: null, single: false };
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => { q.filtros.push(r => r[c] === v); return b; },
        in: (c, vs) => { q.filtros.push(r => vs.includes(r[c])); return b; },
        not: (c, op, v) => { if (op === 'is' && v === null) q.filtros.push(r => r[c] != null); return b; },
        insert: f => { q.op = 'insert'; q.fila = f; return b; },
        update: f => { q.op = 'update'; q.fila = f; return b; },
        single: () => { q.single = true; return b; },
        then: (ok, ko) => Promise.resolve(ejecutar(q)).then(ok, ko),
      };
      return b;
    },
  };
}

// El handler toma getSupabase al cargarse, así que se reemplaza el módulo antes de pedirlo.
let supabaseActual = null;
require.cache[require.resolve(path.join(__dirname, '../api/_supabase'))] = {
  exports: { getSupabase: () => supabaseActual },
};
const handlerImportaciones = require('../api/importaciones');

async function llamar(handler, { method, query = {}, body }) {
  const res = {
    code: 200, body: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(d) { this.body = d; return this; }, end() { return this; },
  };
  await handler({ method, query, body }, res);
  return res;
}

// ── normalizarProveedor ──────────────────────────────────────────────────────
test('el mínimo de compra arranca en USD 300 y no queda en 0 por un campo vacío', () => {
  assert.strictEqual(normalizarProveedor({ nombre: 'Yiwu' }).minimo_usd, 300);
  assert.strictEqual(normalizarProveedor({ nombre: 'Yiwu', minimo_usd: '' }).minimo_usd, 300);
  assert.strictEqual(normalizarProveedor({ nombre: 'Yiwu', minimo_usd: 'abc' }).minimo_usd, 300);
  assert.strictEqual(normalizarProveedor({ nombre: 'Yiwu', minimo_usd: -5 }).minimo_usd, 300);
  assert.strictEqual(normalizarProveedor({ nombre: 'Yiwu', minimo_usd: '450.5' }).minimo_usd, 450.5);
  assert.strictEqual(normalizarProveedor({ nombre: 'Yiwu', minimo_usd: 0 }).minimo_usd, 0, 'un 0 explícito se respeta');
});

test('los textos se recortan y los vacíos quedan en null', () => {
  const f = normalizarProveedor({ nombre: '  Yiwu  ', contacto: '   ', wechat: 'abc' });
  assert.strictEqual(f.nombre, 'Yiwu');
  assert.strictEqual(f.contacto, null);
  assert.strictEqual(f.wechat, 'abc');
});

test('en una edición parcial no se pisa lo que no vino en el cuerpo', () => {
  assert.deepStrictEqual(normalizarProveedor({ telefono: '+86 1' }, { parcial: true }), { telefono: '+86 1' });
});

// ── faltaMigracionProveedores ────────────────────────────────────────────────
test('reconoce la tabla o la columna que todavía no existen', () => {
  assert.ok(faltaMigracionProveedores({ code: 'PGRST205', message: "Could not find the table 'public.proveedores' in the schema cache" }));
  assert.ok(faltaMigracionProveedores({ code: 'PGRST204', message: "Could not find the 'proveedor_id' column" }));
  assert.ok(faltaMigracionProveedores({ code: '42P01', message: 'relation "proveedores" does not exist' }));
  assert.ok(faltaMigracionProveedores({ message: 'column importaciones.proveedor_id does not exist' }));
  assert.ok(!faltaMigracionProveedores({ code: '23505', message: 'duplicate key value' }));
  assert.ok(!faltaMigracionProveedores(null));
});

// ── proveedorPorSku ──────────────────────────────────────────────────────────
test('cada SKU queda con el proveedor de su importación más reciente', () => {
  const imps = [
    { id: 'IMP1', fecha: '2026-03-01', estado: 'recibido', proveedor_id: 'A', items: [{ sku: 'X', qty: 5 }, { sku: 'Y', qty: 5 }] },
    { id: 'IMP2', fecha: '2026-08-01', estado: 'recibido', proveedor_id: 'B', items: [{ sku: 'X', qty: 5 }] },
    // Más nueva pero cancelada: no dice de dónde viene la mercadería.
    { id: 'IMP3', fecha: '2026-09-01', estado: 'cancelled', proveedor_id: 'C', items: [{ sku: 'X', qty: 5 }] },
    // Más nueva pero sin proveedor (cargada antes del campo): no cuenta.
    { id: 'IMP4', fecha: '2026-10-01', estado: 'ordered', proveedor_id: null, items: [{ sku: 'Y', qty: 5 }] },
  ];
  assert.deepStrictEqual(proveedorPorSku(imps, ['X', 'Y', 'Z']), { X: 'B', Y: 'A' });
});

test('dos compras del mismo día: gana la que se cargó después', () => {
  const imps = [
    { id: 'IMP1700000000002', fecha: '2026-10-01', proveedor_id: 'B', items: [{ sku: 'X' }] },
    { id: 'IMP1700000000001', fecha: '2026-10-01', proveedor_id: 'A', items: [{ sku: 'X' }] },
  ];
  assert.deepStrictEqual(proveedorPorSku(imps, ['X']), { X: 'B' });
});

test('sincronizarProveedorProductos hace un update por proveedor', async () => {
  const db = {
    importaciones: [
      { id: 'IMP1', fecha: '2026-03-01', estado: 'recibido', proveedor_id: 'A', items: [{ sku: 'X' }, { sku: 'Y' }] },
      { id: 'IMP2', fecha: '2026-08-01', estado: 'recibido', proveedor_id: 'B', items: [{ sku: 'X' }] },
    ],
    productos: [{ sku: 'X', proveedor_id: null }, { sku: 'Y', proveedor_id: null }, { sku: 'Z', proveedor_id: 'A' }],
  };
  const sb = supabaseFalso(db);
  const r = await sincronizarProveedorProductos(sb, ['X', 'Y']);
  assert.strictEqual(r.asignados, 2);
  assert.deepStrictEqual(db.productos.map(p => p.proveedor_id), ['B', 'A', 'A']);
  assert.strictEqual(sb.writes.length, 2);
});

// ── /api/importaciones ───────────────────────────────────────────────────────
test('una importación nueva guarda el proveedor y se lo asigna a sus productos', async () => {
  const db = {
    importaciones: [],
    productos: [{ sku: 'X', proveedor_id: null }, { sku: 'Y', proveedor_id: 'VIEJO' }, { sku: 'Z', proveedor_id: null }],
  };
  supabaseActual = supabaseFalso(db);
  const res = await llamar(handlerImportaciones, { method: 'POST', body: {
    fecha: '2026-10-24', estado: 'ordered', proveedor_id: 'PROV-1', total: 500,
    items: [{ sku: 'X', qty: 10, costo: 3 }, { sku: 'Y', qty: 20, costo: 2 }],
  } });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(db.importaciones[0].proveedor_id, 'PROV-1');
  assert.deepStrictEqual(res.body.proveedor_sync, { asignados: 2 });
  assert.deepStrictEqual(db.productos.map(p => p.proveedor_id), ['PROV-1', 'PROV-1', null],
    'el producto que se vuelve a comprar pasa al proveedor nuevo; el que no está en la importación no se toca');
});

test('sin la columna proveedor_id la importación se guarda igual y la respuesta lo avisa', async () => {
  const db = { importaciones: [], productos: [{ sku: 'X', proveedor_id: null }] };
  supabaseActual = supabaseFalso(db, { sinColumna: true });
  const res = await llamar(handlerImportaciones, { method: 'POST', body: {
    fecha: '2026-10-24', proveedor_id: 'PROV-1', total: 100, items: [{ sku: 'X', qty: 1, costo: 1 }],
  } });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(db.importaciones.length, 1, 'la importación no se pierde');
  assert.ok(!('proveedor_id' in db.importaciones[0]));
  assert.strictEqual(res.body.migracionProveedorPendiente, true);
  assert.strictEqual(res.body.proveedor_sync, undefined, 'sin columna no se intenta asignar productos');
});

test('ponerle proveedor a una importación vieja ya recibida no vuelve a sumar stock', async () => {
  const db = {
    importaciones: [{ id: 'IMP1', fecha: '2026-03-01', estado: 'recibido', proveedor_id: null, items: [{ sku: 'X', qty: 5 }] }],
    productos: [{ sku: 'X', proveedor_id: null, stock_dep: 3 }],
  };
  supabaseActual = supabaseFalso(db);
  const res = await llamar(handlerImportaciones, { method: 'PUT', query: { id: 'IMP1' }, body: { proveedor_id: 'PROV-1' } });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(db.importaciones[0].proveedor_id, 'PROV-1');
  assert.strictEqual(db.productos[0].proveedor_id, 'PROV-1');
  assert.strictEqual(db.productos[0].stock_dep, 3);
  assert.strictEqual(res.body.stock_sync, undefined);
});

test('editar sólo las notas no pisa una asignación hecha a mano', async () => {
  const db = {
    importaciones: [{ id: 'IMP1', fecha: '2026-03-01', estado: 'ordered', proveedor_id: 'A', items: [{ sku: 'X', qty: 5 }] }],
    productos: [{ sku: 'X', proveedor_id: 'MANUAL' }],
  };
  supabaseActual = supabaseFalso(db);
  const res = await llamar(handlerImportaciones, { method: 'PUT', query: { id: 'IMP1' }, body: { notas: 'llamar', items: [{ sku: 'X', qty: 6 }] } });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(db.productos[0].proveedor_id, 'MANUAL');
  assert.strictEqual(res.body.proveedor_sync, undefined);
});
