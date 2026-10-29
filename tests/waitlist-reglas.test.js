// Waitlist (avisos de stock), directo sobre api/importaciones.js y api/avisos-stock.js con un
// Supabase falso (sin navegador ni red).
//
// Lo que se protege: que un cliente pase a "para avisar" sólo cuando llega una importación
// que trae su SKU —no con cualquier movimiento de stock—, que los que ya estaban listos o
// avisados no se pisen, que un SKU que no se pudo sumar no avise a nadie, y que sin la
// migración la importación se marque como llegada igual.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// El stock se mueve contra MELI y Shopify: acá la llegada sólo suma en la tabla falsa y
// devuelve el mismo reporte que applyImportArrival (aplicados / noEncontrados).
const stockSyncPath = path.join(__dirname, '../api/_stockSync.js');
require.cache[stockSyncPath] = {
  id: stockSyncPath, filename: stockSyncPath, loaded: true,
  exports: {
    applyImportArrival: async (supabase, items) => {
      const aplicados = [], noEncontrados = [];
      for (const it of items) {
        const p = supabase._tablas.productos.find(x => x.sku === it.sku);
        if (!p) { noEncontrados.push(it.sku); continue; }
        p.stock_dep += it.qty;
        aplicados.push({ sku: it.sku, sumado: it.qty, nuevoStock: p.stock_dep });
      }
      return { aplicados, noEncontrados, errores: [] };
    },
  },
};

// Lo justo de PostgREST que usan los dos endpoints. `sinTabla` imita a una base donde la
// migración de avisos_stock no corrió.
function supabaseFalso(tablas, { sinTabla = false } = {}) {
  return {
    _tablas: tablas,
    from(tabla) {
      const q = { op: 'select', filtros: [], fila: null, single: false };
      const ejecutar = () => {
        if (tabla === 'avisos_stock' && sinTabla) {
          return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.avisos_stock' in the schema cache" } };
        }
        const filas = tablas[tabla] = tablas[tabla] || [];
        const pasa = r => q.filtros.every(f => f(r));
        let res;
        if (q.op === 'insert') {
          if (tabla === 'avisos_stock' && filas.some(r => r.cliente_id === q.fila.cliente_id && r.sku === q.fila.sku && ['esperando', 'listo'].includes(r.estado))) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "avisos_stock_abierto_unico"' } };
          }
          filas.push({ ...q.fila }); res = [filas[filas.length - 1]];
        } else if (q.op === 'update') { res = filas.filter(pasa); res.forEach(r => Object.assign(r, q.fila)); }
        else res = filas.filter(pasa);
        if (q.single) return res[0] ? { data: { ...res[0] }, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        return { data: res.map(r => ({ ...r })), error: null };
      };
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => { q.filtros.push(r => r[c] === v); return b; },
        in: (c, vs) => { q.filtros.push(r => vs.includes(r[c])); return b; },
        insert: f => { q.op = 'insert'; q.fila = f; return b; },
        update: f => { q.op = 'update'; q.fila = f; return b; },
        single: () => { q.single = true; return b; },
        then: (ok, ko) => Promise.resolve(ejecutar()).then(ok, ko),
      };
      return b;
    },
  };
}

let supabaseActual = null;
require.cache[require.resolve(path.join(__dirname, '../api/_supabase'))] = {
  exports: { getSupabase: () => supabaseActual },
};
const handlerImportaciones = require('../api/importaciones');
const handlerAvisos = require('../api/avisos-stock');

async function llamar(handler, { method, query = {}, body }) {
  const res = {
    code: 200, body: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(d) { this.body = d; return this; }, end() { return this; },
  };
  await handler({ method, query, body }, res);
  return res;
}

function base() {
  return {
    productos: [
      { sku: 'CASCO-M', stock_dep: 0 },
      { sku: 'ESPEJO', stock_dep: 0 },
      { sku: 'GUANTE', stock_dep: 0 },
    ],
    importaciones: [
      { id: 'IMP1', estado: 'en_transito', items: [
        { sku: 'CASCO-M', qty: 4 }, { sku: 'ESPEJO', qty: 2 }, { sku: 'NO-EXISTE', qty: 1 },
      ] },
    ],
    avisos_stock: [
      { id: 'A1', cliente_id: 'CLI1', sku: 'CASCO-M', estado: 'esperando', importacion_id: null },
      { id: 'A2', cliente_id: 'CLI2', sku: 'CASCO-M', estado: 'esperando', importacion_id: null },
      // Ya avisado por una importación anterior: no se le vuelve a escribir.
      { id: 'A3', cliente_id: 'CLI3', sku: 'CASCO-M', estado: 'avisado', importacion_id: 'IMP0' },
      { id: 'A4', cliente_id: 'CLI1', sku: 'ESPEJO', estado: 'cancelado', importacion_id: null },
      // Un SKU que no viene en esta importación.
      { id: 'A5', cliente_id: 'CLI2', sku: 'GUANTE', estado: 'esperando', importacion_id: null },
      // El SKU viene en la importación pero no existe en productos: no se sumó stock.
      { id: 'A6', cliente_id: 'CLI3', sku: 'NO-EXISTE', estado: 'esperando', importacion_id: null },
    ],
  };
}
const aviso = (t, id) => t.avisos_stock.find(a => a.id === id);

test('al llegar la importación, los que esperaban sus SKUs pasan a "listo" con la importación anotada', async () => {
  const t = base();
  supabaseActual = supabaseFalso(t);
  const r = await llamar(handlerImportaciones, { method: 'PUT', query: { id: 'IMP1' }, body: { estado: 'recibido' } });

  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.avisos_stock.listos.map(a => a.id).sort(), ['A1', 'A2']);
  for (const id of ['A1', 'A2']) {
    assert.strictEqual(aviso(t, id).estado, 'listo');
    assert.strictEqual(aviso(t, id).importacion_id, 'IMP1');
    assert.ok(aviso(t, id).listo_at, 'queda la fecha en la que llegó');
  }
  assert.strictEqual(aviso(t, 'A3').estado, 'avisado', 'un avisado no vuelve a quedar para avisar');
  assert.strictEqual(aviso(t, 'A3').importacion_id, 'IMP0');
  assert.strictEqual(aviso(t, 'A4').estado, 'cancelado', 'un cancelado no revive');
  assert.strictEqual(aviso(t, 'A5').estado, 'esperando', 'un SKU que no vino sigue esperando');
  assert.strictEqual(aviso(t, 'A6').estado, 'esperando', 'si no se pudo sumar el stock no volvió');
});

test('editar una importación que ya había llegado no vuelve a tocar la waitlist', async () => {
  const t = base();
  t.importaciones[0].estado = 'recibido';
  supabaseActual = supabaseFalso(t);
  const r = await llamar(handlerImportaciones, { method: 'PUT', query: { id: 'IMP1' }, body: { estado: 'en_deposito', notas: 'contado' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.avisos_stock, undefined);
  assert.strictEqual(aviso(t, 'A1').estado, 'esperando');
});

test('cambiar el estado a uno que no es de llegada no avisa a nadie', async () => {
  const t = base();
  supabaseActual = supabaseFalso(t);
  await llamar(handlerImportaciones, { method: 'PUT', query: { id: 'IMP1' }, body: { estado: 'en_aduana' } });
  assert.ok(t.avisos_stock.every(a => a.estado !== 'listo'));
});

test('sin la migración la importación llega igual y el stock se suma', async () => {
  const t = base();
  supabaseActual = supabaseFalso(t, { sinTabla: true });
  const r = await llamar(handlerImportaciones, { method: 'PUT', query: { id: 'IMP1' }, body: { estado: 'recibido' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.estado, 'recibido');
  assert.deepStrictEqual(r.body.avisos_stock, { listos: [], migracionPendiente: true });
  assert.strictEqual(t.productos.find(p => p.sku === 'CASCO-M').stock_dep, 4);
});

test('anotar a un cliente: nace esperando, valida el SKU y no lo duplica mientras siga abierto', async () => {
  const t = base();
  supabaseActual = supabaseFalso(t);

  const ok = await llamar(handlerAvisos, { method: 'POST', body: { cliente_id: 'CLI9', sku: 'GUANTE', cantidad: '2', nota: '  talle L ' } });
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body.estado, 'esperando');
  assert.strictEqual(ok.body.cantidad, 2);
  assert.strictEqual(ok.body.nota, 'talle L');

  const dup = await llamar(handlerAvisos, { method: 'POST', body: { cliente_id: 'CLI9', sku: 'GUANTE' } });
  assert.strictEqual(dup.code, 409);

  const inexistente = await llamar(handlerAvisos, { method: 'POST', body: { cliente_id: 'CLI9', sku: 'NADA' } });
  assert.strictEqual(inexistente.code, 400);
  assert.match(inexistente.body.error, /No existe un producto/);

  const sinCantidad = await llamar(handlerAvisos, { method: 'POST', body: { cliente_id: 'CLI8', sku: 'ESPEJO', cantidad: 0 } });
  assert.strictEqual(sinCantidad.body.cantidad, 1, 'una cantidad inválida queda en 1');
});

test('a mano sólo se puede marcar avisado o cancelado', async () => {
  const t = base();
  supabaseActual = supabaseFalso(t);

  const listo = await llamar(handlerAvisos, { method: 'PUT', query: { id: 'A1' }, body: { estado: 'listo' } });
  assert.strictEqual(listo.code, 400, '"listo" lo pone sólo la llegada de una importación');

  const avisado = await llamar(handlerAvisos, { method: 'PUT', query: { id: 'A1' }, body: { estado: 'avisado' } });
  assert.strictEqual(avisado.code, 200);
  assert.strictEqual(aviso(t, 'A1').estado, 'avisado');
  assert.ok(aviso(t, 'A1').avisado_at);
});

test('sin la migración el GET responde vacío y avisa; escribir explica qué falta', async () => {
  supabaseActual = supabaseFalso(base(), { sinTabla: true });
  const get = await llamar(handlerAvisos, { method: 'GET' });
  assert.deepStrictEqual(get.body, { avisos: [], migracionPendiente: true });

  const post = await llamar(handlerAvisos, { method: 'POST', body: { cliente_id: 'CLI1', sku: 'GUANTE' } });
  assert.strictEqual(post.code, 503);
  assert.match(post.body.error, /20261029000000_add_avisos_stock\.sql/);
});
