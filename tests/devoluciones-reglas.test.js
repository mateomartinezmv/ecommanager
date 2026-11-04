// /api/devoluciones con el costo del envío de vuelta, sin navegador: qué se guarda al
// registrar una devolución y al cambiar el costo después, qué montos se rechazan, y qué pasa
// cuando la migración de la columna costo_envio todavía no corrió. La base es un Supabase
// falso en memoria.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { normalizarCostoEnvio, faltaMigracionCostoEnvio } = require('../api/_devoluciones');

function supabaseFalso(db, { sinColumna = false } = {}) {
  const ejecutar = q => {
    const tabla = db[q.tabla] = db[q.tabla] || [];
    const pasa = r => q.filtros.every(f => f(r));
    if (q.fila && sinColumna && 'costo_envio' in q.fila) {
      return { data: null, error: { code: 'PGRST204', message: `Could not find the 'costo_envio' column of '${q.tabla}' in the schema cache` } };
    }
    let filas;
    if (q.op === 'insert') { tabla.push({ ...q.fila }); filas = [tabla[tabla.length - 1]]; }
    else if (q.op === 'update') { filas = tabla.filter(pasa); filas.forEach(r => Object.assign(r, q.fila)); }
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
        single: () => { q.single = true; return b; },
        then: (ok, ko) => Promise.resolve(ejecutar(q)).then(ok, ko),
      };
      return b;
    },
  };
}

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

const base = { ventaId: 'V-1', sku: 'SKU1', producto: 'Slider', cantidad: 1 };

test('normalizarCostoEnvio: vacío es 0, acepta coma decimal y rechaza negativos o texto', () => {
  assert.strictEqual(normalizarCostoEnvio(undefined), 0);
  assert.strictEqual(normalizarCostoEnvio(''), 0);
  assert.strictEqual(normalizarCostoEnvio(350), 350);
  assert.strictEqual(normalizarCostoEnvio('350,555'), 350.56);
  assert.strictEqual(normalizarCostoEnvio(-1), null);
  assert.strictEqual(normalizarCostoEnvio('abc'), null);
});

test('faltaMigracionCostoEnvio reconoce la columna que falta y no otros errores', () => {
  assert.ok(faltaMigracionCostoEnvio({ code: 'PGRST204', message: "Could not find the 'costo_envio' column" }));
  assert.ok(faltaMigracionCostoEnvio({ code: '42703', message: 'column "costo_envio" does not exist' }));
  assert.ok(!faltaMigracionCostoEnvio({ code: '23505', message: 'duplicate key' }));
  assert.ok(!faltaMigracionCostoEnvio(null));
});

test('POST guarda el costo del envío de vuelta', async () => {
  const db = {};
  supabaseActual = supabaseFalso(db);
  const r = await llamar({ method: 'POST', body: { ...base, costoEnvio: '420' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(db.devoluciones[0].costo_envio, 420);
  assert.strictEqual(db.devoluciones[0].estado, 'pendiente');
});

test('POST sin costo no escribe la columna (queda el default 0 de la base)', async () => {
  const db = {};
  supabaseActual = supabaseFalso(db);
  await llamar({ method: 'POST', body: base });
  assert.ok(!('costo_envio' in db.devoluciones[0]));
});

test('POST con un costo inválido no registra nada', async () => {
  const db = {};
  supabaseActual = supabaseFalso(db);
  const r = await llamar({ method: 'POST', body: { ...base, costoEnvio: -10 } });
  assert.strictEqual(r.code, 400);
  assert.strictEqual((db.devoluciones || []).length, 0);
});

test('POST sin la migración registra la devolución igual y lo avisa', async () => {
  const db = {};
  supabaseActual = supabaseFalso(db, { sinColumna: true });
  const r = await llamar({ method: 'POST', body: { ...base, costoEnvio: 300 } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(db.devoluciones.length, 1);
  assert.strictEqual(r.body.migracionCostoEnvioPendiente, '20261104000000_add_costo_envio_devoluciones.sql');
});

test('PATCH cambia sólo el costo del envío', async () => {
  const db = { devoluciones: [{ id: 'DEV-1', sku: 'SKU1', estado: 'recibida', costo_envio: 0 }] };
  supabaseActual = supabaseFalso(db);
  const r = await llamar({ method: 'PATCH', query: { id: 'DEV-1' }, body: { costoEnvio: 275.5 } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(db.devoluciones[0], { id: 'DEV-1', sku: 'SKU1', estado: 'recibida', costo_envio: 275.5 });
});

test('PATCH: id inexistente, monto inválido y migración pendiente', async () => {
  supabaseActual = supabaseFalso({ devoluciones: [] });
  assert.strictEqual((await llamar({ method: 'PATCH', query: { id: 'NO' }, body: { costoEnvio: 1 } })).code, 404);
  assert.strictEqual((await llamar({ method: 'PATCH', query: { id: 'NO' }, body: { costoEnvio: 'x' } })).code, 400);
  assert.strictEqual((await llamar({ method: 'PATCH', body: { costoEnvio: 1 } })).code, 400);

  supabaseActual = supabaseFalso({ devoluciones: [{ id: 'DEV-1' }] }, { sinColumna: true });
  const r = await llamar({ method: 'PATCH', query: { id: 'DEV-1' }, body: { costoEnvio: 100 } });
  assert.strictEqual(r.code, 503);
  assert.match(r.body.error, /20261104000000_add_costo_envio_devoluciones\.sql/);
});
