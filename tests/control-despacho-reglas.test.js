// Lo del control de despacho que vive en el servidor, directo sobre los módulos (sin
// navegador ni MELI): encontrar el envío de una etiqueta escaneada, guardar el número de
// envío cuando lo resuelve MELI o la sincronización, y que todo siga andando con la
// migración 20261103000000_add_control_envios.sql sin correr.

const { test } = require('node:test');
const assert = require('node:assert');
const { codigosCandidatos, buscarEnvioPorCodigo, camposControl, faltaMigracionControl } = require('../api/_controlEnvios');
const { cambiosParaEnvio, sincronizarEnviosDeOrden } = require('../api/_meliEnvios');

const COLUMNAS_NUEVAS = ['meli_shipment_id', 'controlado_at', 'control'];

// Lo justo de PostgREST. `sinColumna` imita la base antes de la migración: las filas no
// traen las columnas nuevas y filtrar o escribir por ellas da el error de Postgres.
function supabaseFalso(db, { sinColumna = false } = {}) {
  const writes = [];
  if (sinColumna) for (const filas of Object.values(db)) for (const r of filas) COLUMNAS_NUEVAS.forEach(c => delete r[c]);
  const ejecutar = q => {
    const tabla = db[q.tabla] = db[q.tabla] || [];
    const usadas = [...q.columnas, ...Object.keys(q.fila || {})];
    if (sinColumna && usadas.some(c => COLUMNAS_NUEVAS.includes(c))) {
      return { data: null, error: { code: '42703', message: `column envios.${usadas.find(c => COLUMNAS_NUEVAS.includes(c))} does not exist` } };
    }
    let filas = tabla.filter(r => q.filtros.every(f => f(r)));
    if (q.op === 'update') { filas.forEach(r => Object.assign(r, q.fila)); writes.push({ tabla: q.tabla, fila: q.fila, ids: filas.map(r => r.id) }); }
    if (q.limite) filas = filas.slice(0, q.limite);
    return { data: filas.map(r => ({ ...r })), error: null };
  };
  return {
    writes,
    from(tabla) {
      const q = { tabla, op: 'select', filtros: [], columnas: [], fila: null, limite: 0 };
      const filtro = (c, f) => { q.columnas.push(c); q.filtros.push(f); return b; };
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => filtro(c, r => r[c] === v),
        in: (c, vs) => filtro(c, r => vs.includes(r[c])),
        like: (c, patron) => filtro(c, r => new RegExp('^' + patron.split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(r[c] || '')),
        limit: n => { q.limite = n; return b; },
        update: f => { q.op = 'update'; q.fila = f; return b; },
        then: (ok, ko) => Promise.resolve(ejecutar(q)).then(ok, ko),
      };
      return b;
    },
  };
}

function base() {
  return {
    envios: [
      { id: 'E_MELI_2000015832269441', orden: '2000019306034118', pack_id: '2000015832269441', venta_id: 'V1',
        tracking: 'MEL48412750656FMDOF01', estado: 'pendiente', fecha_despacho: null, meli_shipment_id: null },
      // Carrito Flex: el envío se guardó con la primera orden; el shipment cubre las dos.
      { id: 'E_MELI_2000099', orden: '2000000000000001', pack_id: '2000099', venta_id: 'V_F1',
        tracking: 'RLX6W3ZYEVLA7AV74YRRYZGI5I', estado: 'pendiente', fecha_despacho: null, meli_shipment_id: null },
    ],
    ventas: [
      { id: 'V_F1', orden_meli: '2000000000000001', pack_id: '2000099' },
      { id: 'V_F2', orden_meli: '2000000000000002', pack_id: '2000099' },
    ],
  };
}

const sinToken = async () => 'TOKEN';
// MELI falso: sólo conoce el shipment 44000000001, que cubre la segunda orden del carrito.
const meliFalso = (llamadas = []) => ({
  obtenerShipment: async (token, id) => { llamadas.push(id); return id === '44000000001' ? { id: 44000000001, status: 'ready_to_ship' } : null; },
  ordenesDelShipment: async (token, id) => (id === '44000000001' ? ['2000000000000002'] : []),
});

test('los números de la etiqueta salen aunque el teclado cambie los símbolos', () => {
  assert.deepStrictEqual(codigosCandidatos('48412750656'), ['48412750656']);
  // QR de Flex leído con el lector en inglés y la PC en español.
  assert.deepStrictEqual(codigosCandidatos('Ñ¨id¨Ñ¨44000000001¨,¨sender?id¨Ñ2715667241,¨hash?code¨Ñ¨abc¨*'),
    ['44000000001', '2715667241']);
  assert.deepStrictEqual(codigosCandidatos('ALERONFINOSNK'), [], 'un SKU no es una etiqueta');
  assert.deepStrictEqual(codigosCandidatos('1234567'), [], 'números cortos no');
});

test('Mercado Envíos: la etiqueta se encuentra en la base por el tracking, sin ir a MELI', async () => {
  const llamadas = [];
  const sb = supabaseFalso(base());
  const r = await buscarEnvioPorCodigo(sb, sinToken, '48412750656', meliFalso(llamadas));
  assert.strictEqual(r.envio.id, 'E_MELI_2000015832269441');
  assert.strictEqual(r.origen, 'base');
  assert.deepStrictEqual(llamadas, []);
});

test('Flex: MELI dice de qué orden es el shipment y el número queda guardado', async () => {
  const db = base();
  const sb = supabaseFalso(db);
  const r = await buscarEnvioPorCodigo(sb, sinToken, '{"id":"44000000001","sender_id":2715667241}', meliFalso());
  assert.strictEqual(r.envio.id, 'E_MELI_2000099', 'llega por la segunda orden del carrito → su pack');
  assert.strictEqual(r.origen, 'meli');
  assert.strictEqual(db.envios[1].meli_shipment_id, '44000000001');
  // La segunda vez ya no pregunta.
  const llamadas = [];
  const otra = await buscarEnvioPorCodigo(sb, sinToken, '44000000001', meliFalso(llamadas));
  assert.strictEqual(otra.origen, 'base');
  assert.deepStrictEqual(llamadas, []);
});

test('un código que no es de ningún envío devuelve null', async () => {
  const sb = supabaseFalso(base());
  assert.strictEqual(await buscarEnvioPorCodigo(sb, sinToken, '99999999999', meliFalso()), null);
  assert.strictEqual(await buscarEnvioPorCodigo(sb, sinToken, 'XYZ', meliFalso()), null);
});

test('sin la migración la búsqueda anda igual y no intenta guardar el número', async () => {
  const db = base();
  const sb = supabaseFalso(db, { sinColumna: true });
  assert.strictEqual((await buscarEnvioPorCodigo(sb, sinToken, '48412750656', meliFalso())).envio.id, 'E_MELI_2000015832269441');
  const r = await buscarEnvioPorCodigo(sb, sinToken, '44000000001', meliFalso());
  assert.strictEqual(r.envio.id, 'E_MELI_2000099');
  assert.deepStrictEqual(sb.writes, []);
});

test('la sincronización guarda el número de envío sólo si la columna existe', async () => {
  const shipment = { id: 44000000001, status: 'ready_to_ship', substatus: 'printed' };
  assert.deepStrictEqual(cambiosParaEnvio({ estado: 'pendiente', tracking: 'X', meli_shipment_id: null }, shipment),
    { meli_shipment_id: '44000000001' });
  assert.strictEqual(cambiosParaEnvio({ estado: 'pendiente', tracking: 'X', meli_shipment_id: '44000000001' }, shipment), null);
  assert.strictEqual(cambiosParaEnvio({ estado: 'pendiente', tracking: 'X' }, shipment), null, 'sin la columna no se escribe');

  const db = base();
  await sincronizarEnviosDeOrden(supabaseFalso(db), '2000000000000001', shipment);
  assert.strictEqual(db.envios[1].meli_shipment_id, '44000000001');

  const viejo = base();
  const sb = supabaseFalso(viejo, { sinColumna: true });
  await sincronizarEnviosDeOrden(sb, '2000000000000001', { ...shipment, tracking_number: 'NUEVO' });
  assert.deepStrictEqual(sb.writes.map(w => w.fila), [], 'el tracking ya estaba: nada que escribir, y sin romper');
});

test('el PUT sólo toca las columnas del control que vienen', () => {
  assert.deepStrictEqual(camposControl({ estado: 'en_camino' }), {});
  assert.deepStrictEqual(camposControl({ controladoAt: '2026-11-03T15:00:00Z', control: { items: [] } }),
    { controlado_at: '2026-11-03T15:00:00Z', control: { items: [] } });
  assert.deepStrictEqual(camposControl({ controladoAt: null }), { controlado_at: null }, 'deshacer el control');
  assert.ok(faltaMigracionControl({ code: 'PGRST204', message: "Could not find the 'control' column" }));
  assert.ok(!faltaMigracionControl({ code: '23505', message: 'duplicate key' }));
});
