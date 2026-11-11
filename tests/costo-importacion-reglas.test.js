// Costos de importación con el esquema de puesta en puerto (GrupoRAS) y el costo de cada
// producto por PPP, sin navegador: las reglas de public/costo-importacion.js y lo que hace
// /api/importaciones al crear, editar, pagar y recibir una importación, con un Supabase falso
// en memoria. El stock de la llegada se simula: la sincronización con MELI/Shopify tiene sus
// propios tests.
//
// Los números son los de la importación de JBL de noviembre 2026: USD 1.064,45 en China y una
// cotización puesta en puerto (FOB + flete) de USD 1.460,45.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CI = require('../public/costo-importacion');

const ITEMS_JBL = [
  { sku: 'HSJ-20121', nombre: 'Espejos Alerón Naked', qty: 80, costo: 3.8 },
  { sku: 'CPJ-62001', nombre: 'Porta matrícula rebatible', qty: 25, costo: 3.7 },
  { sku: 'GZTYJ-41046N', nombre: 'Soporte gato negro', qty: 5, costo: 12 },
  { sku: '', nombre: 'Espejo deportivo con señalero', qty: 10, costo: 8.4 },
];
const CHINA = 80 * 3.8 + 25 * 3.7 + 5 * 12 + 10 * 8.4; // 304 + 92.5 + 60 + 84 = 540.5

// ── Reglas ───────────────────────────────────────────────────────────────────
test('el factor es costo total sin IVA ÷ costo en China, como en la planilla de JBL', () => {
  const imp = { items: [{ sku: 'X', qty: 1, costo: 1064.45 }], costo_puerto: 1460.45 };
  const t = CI.totales(imp);
  assert.strictEqual(t.modelo, 'puerto');
  assert.strictEqual(t.costoChina, 1064.45);
  assert.strictEqual(t.flete, 396);
  assert.strictEqual(t.total, 1460.45);
  assert.strictEqual(t.factor, 1.372);

  // La nacionalización y el traslado se suman, sin IVA, y suben el factor.
  const conNac = CI.totales({ ...imp, nacional: 120, traslado: 15 });
  assert.strictEqual(conNac.total, 1595.45);
  assert.strictEqual(conNac.factor, 1.4988);
});

test('una importación del esquema anterior no tiene factor: su total es lo pagado con IVA', () => {
  const t = CI.totales({ items: ITEMS_JBL, total: 1550, nacional: 980 });
  assert.strictEqual(t.modelo, 'iva');
  assert.strictEqual(t.factor, null);
  assert.strictEqual(t.total, 1550);
  assert.deepStrictEqual(CI.planPPP({ items: ITEMS_JBL, total: 1550 }, []).aplica, false);
});

test('cada unidad carga el mismo factor y pasa a pesos con la cotización de la importación', () => {
  const imp = { items: ITEMS_JBL, costo_puerto: CHINA * 1.4, cotizacion_usd: 40 };
  const u = CI.costosUnitarios(imp);
  assert.strictEqual(u[0].costoUsd, 5.32);          // 3,80 × 1,4
  assert.strictEqual(u[0].costoUyu, 212.8);         // × 40
  assert.strictEqual(u[2].costoUyu, 672);           // 12 × 1,4 × 40
  // Sin cotización cargada se usa la de la planilla (40).
  assert.strictEqual(CI.costosUnitarios({ ...imp, cotizacion_usd: null })[0].costoUyu, 212.8);
});

test('los pagos: 50% al proveedor, 50% a los 10 días y el saldo al llegar a puerto', () => {
  const imp = { fecha: '2026-11-11', llegada: '2027-01-20', items: [{ sku: 'X', qty: 1, costo: 1064.45 }],
    costo_puerto: 1460.45, nacional: 250 };
  const p = CI.armarPagos(imp, []);
  assert.deepStrictEqual(p.map(x => [x.id, x.monto, x.estimado, x.a]), [
    ['anticipo', 532.23, '2026-11-11', 'proveedor'],
    ['saldo_proveedor', 532.22, '2026-11-21', 'proveedor'],
    ['puerto', 646, '2027-01-20', 'importador'],     // 396 de flete + 250 de nacionalización
  ]);
  assert.strictEqual(p.reduce((s, x) => s + x.monto, 0), 1710.45, 'los tres pagos suman el costo total');
  assert.ok(p.every(x => !x.pagado));
});

test('al recalcular los pagos se conserva lo marcado y los montos siguen a los costos', () => {
  const imp = { fecha: '2026-11-11', items: [{ sku: 'X', qty: 1, costo: 1000 }], costo_puerto: 1400 };
  const previos = [
    { id: 'anticipo', pagado: true, fecha_pago: '2026-11-11', monto: 1 },
    { id: 'saldo_proveedor', estimado: '2026-11-18', estimado_manual: true },
  ];
  const p = CI.armarPagos({ ...imp, nacional: 100 }, previos);
  assert.strictEqual(p[0].pagado, true);
  assert.strictEqual(p[0].fecha_pago, '2026-11-11');
  assert.strictEqual(p[0].monto, 500, 'el monto no se toma de lo que mandó la pantalla');
  assert.strictEqual(p[1].estimado, '2026-11-18', 'una fecha cambiada a mano se respeta');
  assert.strictEqual(p[2].monto, 500);              // 400 de flete + 100 de nacionalización
  assert.deepStrictEqual(CI.resumenPagos(p), { pagado: 500, pendiente: 1000, proximo: p[1], completos: false });
});

test('la PI real de JBL: la puesta FOB va al proveedor, que cobra dos pagos de USD 575', () => {
  // Productos EXW USD 1.128,90 + shipping 23,10 = 1.152 en la PI, cobrados 1.150 en Alibaba.
  const imp = { fecha: '2026-11-11', llegada: '2027-01-25', items: [{ sku: 'X', qty: 1, costo: 1128.9 }],
    traslado: 21.1, costo_puerto: 1128.9 + 396 };
  const t = CI.totales(imp);
  assert.strictEqual(t.costoChina, 1128.9);
  assert.strictEqual(t.proveedor, 1150);
  assert.strictEqual(t.flete, 396, 'el all in del importador');
  assert.strictEqual(t.total, 1546);
  assert.strictEqual(t.factor, 1.3695);
  const p = CI.armarPagos(imp, []);
  assert.deepStrictEqual(p.map(x => [x.id, x.monto, x.a]), [
    ['anticipo', 575, 'proveedor'], ['saldo_proveedor', 575, 'proveedor'], ['puerto', 396, 'importador'],
  ]);
  assert.strictEqual(CI.diferenciaPagos(imp, p).diferencia, 0);
});

test('un monto cambiado a mano se respeta al recalcular y se puede volver al calculado', () => {
  const imp = { fecha: '2026-11-11', items: [{ sku: 'X', qty: 1, costo: 1064.45 }], costo_puerto: 1460.45 };
  const p = CI.armarPagos(imp, [{ id: 'saldo_proveedor', monto: 575, monto_manual: true }]);
  assert.strictEqual(p[1].monto, 575);
  assert.strictEqual(p[1].monto_calculado, 532.22);
  assert.strictEqual(p[1].monto_manual, true);
  assert.strictEqual(p[0].monto, 532.23, 'los otros siguen calculados');
  assert.deepStrictEqual(CI.diferenciaPagos(imp, p), { suma: 1503.23, total: 1460.45, diferencia: 42.78 });

  // Cambian los costos: el editado queda, los demás se recalculan.
  const p2 = CI.armarPagos({ ...imp, costo_puerto: 1500 }, p);
  assert.strictEqual(p2[1].monto, 575);
  assert.strictEqual(p2[2].monto, 435.55);

  // Sin la marca de manual (↺), vuelve al calculado; un monto vacío no cuenta como manual.
  assert.strictEqual(CI.armarPagos(imp, [{ id: 'saldo_proveedor', monto: 575, monto_manual: false }])[1].monto, 532.22);
  assert.strictEqual(CI.armarPagos(imp, [{ id: 'saldo_proveedor', monto: '', monto_manual: true }])[1].monto, 532.22);
  assert.strictEqual(CI.armarPagos(imp, [{ id: 'saldo_proveedor', monto: NaN, monto_manual: true }])[1].monto, 532.22);
});

test('PPP: promedio ponderado entre el depósito y lo que llega', () => {
  assert.strictEqual(CI.ppp(13, 342, 80, 212.8), 230.86);   // (13×342 + 80×212,8) ÷ 93 = 21.470 ÷ 93
  assert.strictEqual(CI.ppp(0, 342, 80, 212.8), 212.8, 'sin stock, el costo es el de la importación');
  assert.strictEqual(CI.ppp(-2, 342, 80, 212.8), 212.8, 'un stock negativo cuenta como cero');
  assert.strictEqual(CI.ppp(15, 0, 10, 100), 100, 'sin costo previo cargado no se promedia contra cero');
  assert.strictEqual(CI.ppp(10, 100, 0, 50), 100, 'si no llega nada, no cambia');
});

test('el plan del PPP junta renglones del mismo SKU y separa lo que no está en productos', () => {
  const imp = { costo_puerto: 140, cotizacion_usd: 40, items: [
    { sku: 'A', qty: 10, costo: 2 }, { sku: 'A', qty: 10, costo: 4 },    // promedio 3 USD en China
    { sku: 'NUEVO', qty: 5, costo: 4 }, { sku: '', nombre: 'sin sku', qty: 5, costo: 4 },
  ] };
  // China = 20 + 40 + 20 + 20 = 100 → factor 1,4
  const plan = CI.planPPP(imp, [{ sku: 'A', stock_dep: 20, costo: 300 }]);
  assert.strictEqual(plan.aplica, true);
  assert.deepStrictEqual(plan.sinProducto, ['NUEVO']);
  assert.deepStrictEqual(plan.cambios, [
    { sku: 'A', qty: 20, stockAntes: 20, costoAntes: 300, costoImport: 168, costoNuevo: 234 },
  ]);
});

// ── /api/importaciones con un Supabase falso ────────────────────────────────
function supabaseFalso(db) {
  const ejecutar = q => {
    const tabla = db[q.tabla] = db[q.tabla] || [];
    const pasa = r => q.filtros.every(f => f(r));
    let filas;
    if (q.op === 'insert') { tabla.push({ ...q.fila }); filas = [tabla[tabla.length - 1]]; }
    else if (q.op === 'update') { filas = tabla.filter(pasa); filas.forEach(r => Object.assign(r, q.fila)); }
    else filas = tabla.filter(pasa);
    if (q.cols) filas = filas.map(r => Object.fromEntries(q.cols.map(c => [c, r[c]])));
    return { data: q.single ? (filas[0] ? { ...filas[0] } : null) : filas.map(r => ({ ...r })), error: null };
  };
  return {
    from(tabla) {
      const q = { tabla, op: 'select', filtros: [], fila: null, single: false, cols: null };
      const b = {
        select: c => { if (q.op === 'select' && c && c !== '*') q.cols = c.split(',').map(s => s.trim()); return b; },
        order: () => b,
        eq: (c, v) => { q.filtros.push(r => r[c] === v); return b; },
        in: (c, vs) => { q.filtros.push(r => vs.includes(r[c])); return b; },
        not: () => b,
        insert: f => { q.op = 'insert'; q.fila = f; return b; },
        update: f => { q.op = 'update'; q.fila = f; return b; },
        single: () => { q.single = true; return b; },
        then: (ok, ko) => Promise.resolve(ejecutar(q)).then(ok, ko),
      };
      return b;
    },
  };
}

let db = null;
const mockear = (modulo, exports) => {
  require.cache[require.resolve(path.join(__dirname, '../api', modulo))] = { exports };
};
mockear('_supabase', { getSupabase: () => supabaseFalso(db) });
// La llegada suma el stock en la base falsa, como hace sincronizarStock con stock_dep.
mockear('_stockSync', {
  applyImportArrival: async (_sb, items) => {
    const aplicados = [], noEncontrados = [];
    for (const it of items) {
      if (!it.sku) continue;
      const p = db.productos.find(x => x.sku === it.sku);
      if (!p) { noEncontrados.push(it.sku); continue; }
      p.stock_dep += it.qty;
      aplicados.push({ sku: it.sku, sumado: it.qty, nuevoStock: p.stock_dep });
    }
    return { aplicados, noEncontrados, errores: [] };
  },
});
mockear('_avisosStock', { marcarAvisosListos: async () => ({ listos: [] }) });
const handler = require('../api/importaciones');

async function llamar({ method, query = {}, body }) {
  const res = {
    code: 200, body: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(d) { this.body = d; return this; }, end() { return this; },
  };
  await handler({ method, query, body }, res);
  return res;
}

function dbDemo() {
  return {
    importaciones: [],
    proveedores: [],
    productos: [
      { sku: 'HSJ-20121', stock_dep: 13, costo: 342 },
      { sku: 'CPJ-62001', stock_dep: 25, costo: 405 },
      { sku: 'GZTYJ-41046N', stock_dep: 0, costo: 1170 },
      { sku: 'VIEJO', stock_dep: 4, costo: 500 },
    ],
  };
}

test('crear una importación GrupoRAS calcula el total sin IVA y los tres pagos', async () => {
  db = dbDemo();
  const r = await llamar({ method: 'POST', body: {
    fecha: '2026-11-11', llegada: '2027-01-20', estado: 'ordered', items: ITEMS_JBL,
    importador: ' GrupoRAS ', costo_puerto: '756.70', nacional: '', traslado: 0, cotizacion_usd: '',
    pagos: [{ id: 'anticipo', pagado: true, fecha_pago: '2026-11-11', monto: 999 }],
    // Lo que mande la pantalla del esquema viejo no pisa la cuenta.
    total: 1, saldo_pendiente: false,
  } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const imp = db.importaciones[0];
  assert.strictEqual(imp.importador, 'GrupoRAS');
  assert.strictEqual(imp.costo_puerto, 756.7);
  assert.strictEqual(imp.cotizacion_usd, 40);
  assert.strictEqual(imp.total, 756.7);
  assert.strictEqual(imp.subtotal, 756.7);
  assert.strictEqual(imp.iva, 0);
  assert.deepStrictEqual(imp.pagos.map(p => [p.id, p.monto, p.pagado]), [
    ['anticipo', 270.25, true], ['saldo_proveedor', 270.25, false], ['puerto', 216.2, false],
  ]);
  assert.strictEqual(imp.saldo_pendiente, true);
});

test('cargar la nacionalización después recalcula el total y el pago en puerto, sin perder lo pagado', async () => {
  const id = db.importaciones[0].id;
  const r = await llamar({ method: 'PUT', query: { id }, body: { nacional: 108.1 } });
  assert.strictEqual(r.code, 200);
  const imp = db.importaciones[0];
  assert.strictEqual(imp.total, 864.8);
  assert.strictEqual(imp.pagos[0].pagado, true, 'el anticipo sigue pagado');
  assert.strictEqual(imp.pagos[2].monto, 324.3);
  assert.strictEqual(CI.totales(imp).factor, 1.6);

  // Marcar los otros dos pagos deja la importación sin saldo.
  const pagos = imp.pagos.map(p => ({ ...p, pagado: true, fecha_pago: p.fecha_pago || '2026-11-20' }));
  await llamar({ method: 'PUT', query: { id }, body: { pagos } });
  assert.strictEqual(db.importaciones[0].saldo_pendiente, false);
});

test('un pago editado a mano se guarda y sobrevive a otros cambios de la importación', async () => {
  const id = db.importaciones[0].id;
  const antes = db.importaciones[0].pagos;
  const pagos = antes.map(p => p.id === 'puerto' ? { ...p, monto: 350, monto_manual: true } : p);
  await llamar({ method: 'PUT', query: { id }, body: { pagos } });
  await llamar({ method: 'PUT', query: { id }, body: { notas: 'cambio de nota' } });
  const p = db.importaciones[0].pagos.find(x => x.id === 'puerto');
  assert.strictEqual(p.monto, 350);
  assert.strictEqual(p.monto_calculado, 324.3);
  assert.strictEqual(db.importaciones[0].total, 864.8, 'el costo total no cambia por editar un pago');
  // Se deja como estaba para el test siguiente.
  db.importaciones[0].pagos = antes;
});

test('al llegar, cada producto toma su costo por PPP y no se vuelve a aplicar', async () => {
  const id = db.importaciones[0].id;
  const r = await llamar({ method: 'PUT', query: { id }, body: { estado: 'recibido', llegada: '2027-01-18' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  // factor 1,6 × 40 = 64 pesos por dólar de China.
  const esperado = [
    { sku: 'HSJ-20121', qty: 80, stockAntes: 13, costoAntes: 342, costoImport: 243.2, costoNuevo: CI.ppp(13, 342, 80, 243.2) },
    { sku: 'CPJ-62001', qty: 25, stockAntes: 25, costoAntes: 405, costoImport: 236.8, costoNuevo: 320.9 },
    { sku: 'GZTYJ-41046N', qty: 5, stockAntes: 0, costoAntes: 1170, costoImport: 768, costoNuevo: 768 },
  ];
  assert.deepStrictEqual(r.body.costos_ppp.aplicados, esperado);
  assert.deepStrictEqual(r.body.costos_ppp.sinProducto, []);
  assert.strictEqual(db.productos.find(p => p.sku === 'HSJ-20121').costo, 257.01);
  assert.strictEqual(db.productos.find(p => p.sku === 'HSJ-20121').stock_dep, 93);
  assert.strictEqual(db.productos.find(p => p.sku === 'VIEJO').costo, 500, 'lo que no vino no se toca');
  assert.ok(db.importaciones[0].costos_aplicados_at);
  assert.deepStrictEqual(db.importaciones[0].costos_aplicados, esperado);

  // Volver a marcarla (ej: pasó a en_deposito) no promedia otra vez ni suma stock.
  await llamar({ method: 'PUT', query: { id }, body: { estado: 'en_deposito' } });
  assert.strictEqual(db.productos.find(p => p.sku === 'HSJ-20121').costo, 257.01);
  assert.strictEqual(db.productos.find(p => p.sku === 'HSJ-20121').stock_dep, 93);
});

test('una importación del esquema anterior llega sin tocar el costo de los productos', async () => {
  db = dbDemo();
  db.importaciones.push({ id: 'IMP-VIEJA', fecha: '2026-09-24', estado: 'ordered', total: 1926, subtotal: 1578.69, iva: 347.31,
    nacional: 1076, traslado: 13, saldo_pendiente: true, items: [{ sku: 'VIEJO', qty: 10, costo: 5 }] });
  const r = await llamar({ method: 'PUT', query: { id: 'IMP-VIEJA' }, body: { estado: 'recibido' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.costos_ppp, undefined);
  assert.strictEqual(db.productos.find(p => p.sku === 'VIEJO').costo, 500);
  assert.strictEqual(db.productos.find(p => p.sku === 'VIEJO').stock_dep, 14);
  assert.strictEqual(db.importaciones[0].total, 1926, 'el total con IVA queda como estaba');
});

test('sin la migración, el error dice qué archivo correr', async () => {
  db = dbDemo();
  const sb = supabaseFalso(db);
  const original = sb.from;
  mockear('_supabase', { getSupabase: () => ({ from: t => {
    const b = original(t);
    const insert = b.insert;
    b.insert = f => { const r = insert(f); r.then = ok => Promise.resolve({ data: null,
      error: { code: 'PGRST204', message: "Could not find the 'costo_puerto' column of 'importaciones' in the schema cache" } }).then(ok); return r; };
    return b;
  } }) });
  delete require.cache[require.resolve('../api/importaciones')];
  const h = require('../api/importaciones');
  const res = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { this.body = d; return this; } };
  await h({ method: 'POST', query: {}, body: { fecha: '2026-11-11', items: ITEMS_JBL, costo_puerto: 700 } }, res);
  assert.strictEqual(res.code, 500);
  assert.match(res.body.error, /20261111000000_importaciones_puerto_ppp\.sql/);
});
