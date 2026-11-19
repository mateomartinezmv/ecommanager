// El tracking de contenedores sin navegador: el número ISO 6346, la respuesta de PIL (la real
// del contenedor PCIU 891912-8, guardada en fixtures/), la etapa y el arribo que salen de los
// movimientos, lo que falta pagar de las PIs que viajan adentro, y lo que hacen
// /api/tracking y el cron con un Supabase falso: guardar la llegada que se había calculado,
// llevar el arribo a las importaciones, anotar cada cambio del arribo y avisar por Telegram.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const TC = require('../public/tracking-contenedores');
const CI = require('../public/costo-importacion');
const { parsearPIL, fechaPIL, consultarPIL, REFERER } = require('../api/_pil');
const { aplicarConsulta, mensajeNovedades, normalizarTracking } = require('../api/_tracking');

const RESPUESTA_PIL = require('./fixtures/pil-PCIU8919128.json');
const PIL = parsearPIL(RESPUESTA_PIL.data);

// Los movimientos del fixture como si el viaje hubiera avanzado hasta `hasta` (inclusive).
function avanzar(hasta, { eta } = {}) {
  return PIL.eventos.map((e, i) => {
    const ev = { ...e };
    if (eta && e.evento === 'Vessel Discharge') ev.fecha = eta;
    if (i <= hasta) { ev.estimado = false; ev.fecha = ev.fecha || '2026-12-28'; }
    return ev;
  });
}

// ── Número de contenedor ─────────────────────────────────────────────────────
test('el número de contenedor se valida con el dígito de control ISO 6346', () => {
  assert.strictEqual(TC.digitoControl('PCIU891912'), 8);
  assert.ok(TC.digitoControlValido('PCIU 891912-8'));
  assert.ok(TC.digitoControlValido('pciu8919128'), 'sin importar espacios, guiones ni minúsculas');
  assert.ok(!TC.digitoControlValido('PCIU8919129'), 'un dígito mal copiado se detecta');
  assert.ok(TC.digitoControlValido('MSCU1234566'));
  assert.ok(!TC.formatoContenedorValido('PCIU891912'), 'le falta un número');
  assert.ok(!TC.formatoContenedorValido('PCI8919128X'));
  assert.strictEqual(TC.formatearContenedor('PCIU8919128'), 'PCIU 891912-8');
  assert.strictEqual(TC.normalizarContenedor(' PCIU 891912-8 '), 'PCIU8919128');
});

test('el link de PIL se arma con el número y uno pegado a mano tiene prioridad', () => {
  assert.strictEqual(TC.linkSeguimiento({ naviera: 'PIL', contenedor: 'PCIU 891912-8' }),
    'https://www.pilship.com/digital-solutions/?tab=customer&id=track-trace&label=containerTandT&module=TrackContStatus&refNo=PCIU8919128');
  assert.strictEqual(TC.linkSeguimiento({ naviera: 'MSC', contenedor: 'MSCU1234566' }), null);
  assert.strictEqual(TC.linkSeguimiento({ naviera: 'MSC', contenedor: 'MSCU1234566', link_seguimiento: 'https://x.test/t' }), 'https://x.test/t');
  assert.ok(TC.navieraAutomatica('pil'));
  assert.ok(!TC.navieraAutomatica('MSC'));
  assert.strictEqual(TC.naviera('cualquiera').id, 'OTRA');
});

// ── Respuesta de PIL ─────────────────────────────────────────────────────────
test('las fechas de PIL distinguen lo que pasó de lo estimado (*) y de lo que no tiene fecha', () => {
  assert.deepStrictEqual(fechaPIL('12-Nov-2026 01:36:00'), { fecha: '2026-11-12', hora: '01:36', estimado: false });
  assert.deepStrictEqual(fechaPIL('* 26-Dec-2026 11:00:00'), { fecha: '2026-12-26', hora: '11:00', estimado: true });
  assert.deepStrictEqual(fechaPIL('16-Nov-2026'), { fecha: '2026-11-16', hora: null, estimado: false });
  assert.strictEqual(fechaPIL('Information Not Available'), null);
});

test('la respuesta real de PIL se lee entera: tramo, buque y los 6 movimientos', () => {
  assert.deepStrictEqual(PIL.tramos, [{
    tipo: 'Load Port', puerto: 'NINGBO', codigo: 'CNNGB', llegada: '2026-11-16', salida: '2026-11-19',
    buque: 'COSCO SHIPPING RHINE', viaje: 'VCSN0043W', proximo: 'UYMVD', eta_proximo: '2026-12-26',
  }]);
  assert.deepStrictEqual(PIL.eventos.map(e => [e.evento, e.fecha, e.estimado, e.lugar]), [
    ['O/B Empty Container Released', '2026-11-12', false, 'NINGBO'],
    ['Truck Gate In to O/B Terminal', '2026-11-15', false, 'NINGBO'],
    ['Vessel Loading', '2026-11-21', true, 'NINGBO'],
    ['Vessel Discharge', '2026-12-26', true, 'MONTEVIDEO'],
    ['Truck Gate Out from I/B Terminal', null, true, 'MONTEVIDEO'],
    ['I/B Empty Container Returned', null, true, 'MONTEVIDEO'],
  ]);
  assert.strictEqual(PIL.eventos[2].buque, 'COSCO SHIPPING RHINE');
});

test('de los movimientos sale la etapa, el zarpe y el arribo a Montevideo', () => {
  const d = TC.derivarDeEventos(PIL.eventos, PIL.tramos);
  assert.strictEqual(d.estado, 'terminal', 'entró a la terminal de Ningbo y todavía no lo cargaron');
  assert.strictEqual(d.etd, '2026-11-21');
  assert.strictEqual(d.eta, '2026-12-26');
  assert.strictEqual(d.puerto_origen, 'NINGBO');
  assert.strictEqual(d.puerto_destino, 'MONTEVIDEO');
  assert.strictEqual(d.buque, 'COSCO SHIPPING RHINE');
  assert.strictEqual(d.viaje, 'VCSN0043W');
  assert.deepStrictEqual(d.transbordos, []);
  assert.ok(!d.zarpo && !d.arribo);
});

test('la etapa avanza con el viaje: navegando, en el puerto y retirado', () => {
  assert.strictEqual(TC.derivarDeEventos([], []).estado, 'reservado');
  assert.strictEqual(TC.derivarDeEventos(PIL.eventos.slice(0, 1), PIL.tramos).estado, 'origen', 'sólo retiraron el vacío');
  assert.strictEqual(TC.derivarDeEventos(avanzar(1), PIL.tramos).estado, 'terminal');
  assert.strictEqual(TC.derivarDeEventos(avanzar(2), PIL.tramos).estado, 'navegando');
  assert.strictEqual(TC.derivarDeEventos(avanzar(3), PIL.tramos).estado, 'en_puerto');
  assert.strictEqual(TC.derivarDeEventos(avanzar(4), PIL.tramos).estado, 'retirado');
  assert.ok(TC.derivarDeEventos(avanzar(2), PIL.tramos).zarpo);
});

test('con transbordo, el arribo es la última descarga y la del medio es transbordo', () => {
  const ev = [
    { fecha: '2026-11-21', estimado: false, evento: 'Vessel Loading', lugar: 'NINGBO', buque: 'A' },
    { fecha: '2026-12-02', estimado: false, evento: 'Vessel Discharge', lugar: 'SINGAPORE', buque: 'A' },
    { fecha: '2026-12-05', estimado: true, evento: 'Vessel Loading', lugar: 'SINGAPORE', buque: 'B' },
    { fecha: '2027-01-03', estimado: true, evento: 'Vessel Discharge', lugar: 'MONTEVIDEO', buque: 'B' },
  ];
  const d = TC.derivarDeEventos(ev, []);
  assert.strictEqual(d.estado, 'transbordo');
  assert.strictEqual(d.eta, '2027-01-03');
  assert.deepStrictEqual(d.transbordos, ['SINGAPORE']);
  assert.strictEqual(d.buque, 'A', 'el buque en el que viaja ahora');
  ev[2].estimado = false;
  assert.strictEqual(TC.derivarDeEventos(ev, []).estado, 'navegando');
  assert.strictEqual(TC.derivarDeEventos(ev, []).buque, 'B');
});

test('el barco se ubica en la línea según el tiempo entre zarpe y arribo', () => {
  const t = { estado: 'navegando', etd: '2026-11-21', eta: '2026-12-26' };
  assert.strictEqual(TC.progresoViaje({ ...t, estado: 'terminal' }, '2026-12-01'), 0);
  assert.strictEqual(TC.progresoViaje({ ...t, estado: 'en_puerto' }, '2026-12-01'), 1);
  assert.strictEqual(TC.progresoViaje(t, '2026-12-08'), 17 / 35);
  assert.strictEqual(TC.progresoViaje(t, '2027-02-01'), 0.97, 'atrasado no llega al puerto hasta que descarga');
  assert.strictEqual(TC.diasEntre('2026-11-19', '2026-12-26'), 37);
});

// ── Lo que falta pagar ───────────────────────────────────────────────────────
const IMP_13772 = { id: 'IMP-13772', fecha: '2026-09-24', llegada: '2026-12-12', estado: 'ordered', notas: 'PI13772', proveedor_id: 'P-TOM',
  traslado: 13, nacional: 1076, total: 1926, saldo_pendiente: false, items: [{ sku: 'DFB-002', qty: 40, costo: 5.8 }, { sku: 'GZ', qty: 30, costo: 11.5 }, { sku: 'ESP', qty: 60, costo: 4.333333 }] };
const IMP_14175 = { id: 'IMP-14175', fecha: '2026-10-13', llegada: '2027-01-02', estado: 'ordered', notas: 'PI14175', proveedor_id: 'P-APOLLO',
  traslado: 23, nacional: 1312, total: 2003, saldo_pendiente: true, items: [{ sku: 'BAUL45', qty: 20, costo: 7.9 }, { sku: 'BAUL28', qty: 30, costo: 8 }, { sku: 'ESC', qty: 18, costo: 13.5 }, { sku: 'T', qty: 1, costo: 27 }] };
const IMP_14713 = { id: 'IMP-14713', fecha: '2026-10-30', llegada: '2027-01-15', estado: 'ordered', notas: null, proveedor_id: 'P-MUXUAN',
  traslado: 8, nacional: 466.5, total: 890, saldo_pendiente: true, items: [{ sku: 'PATENTE', qty: 15, costo: 25 }, { sku: 'SENAL', qty: 30, costo: 1.38 }] };

test('del esquema anterior falta la segunda mitad de la PI (productos + shipping)', () => {
  assert.strictEqual(CI.costoChina(IMP_14175.items), 668);
  assert.deepStrictEqual(TC.pendienteDeImportacion(IMP_14175), {
    monto: 345.5, modelo: 'iva',
    lineas: [{ id: 'saldo_pi', concepto: '2da mitad de la PI', a: 'proveedor', monto: 345.5, totalPI: 691 }],
  });
  assert.strictEqual(TC.pendienteDeImportacion(IMP_14713).monto, 212.2);
  assert.strictEqual(TC.pendienteDeImportacion(IMP_13772).monto, 0, 'la PI ya pagada no debe nada');
  assert.strictEqual(TC.pendienteDeImportacion({ ...IMP_14175, estado: 'cancelled' }).monto, 0);
});

test('con puesta en puerto falta lo que no está marcado como pagado, comisiones incluidas', () => {
  const imp = { fecha: '2026-11-11', llegada: '2027-01-25', costo_puerto: 1524.9, traslado: 21.1, items: [{ qty: 1, costo: 1128.9 }],
    pagos: [
      { id: 'anticipo', concepto: '50% al proveedor', a: 'proveedor', monto: 575, fee: 20, pagado: true },
      { id: 'saldo_proveedor', concepto: '50% restante', a: 'proveedor', monto: 575, fee: 5, pagado: false },
      { id: 'puerto', concepto: 'All in del importador', a: 'importador', monto: 396, pagado: false, estimado: '2027-01-25' },
    ] };
  const p = TC.pendienteDeImportacion(imp);
  assert.strictEqual(p.modelo, 'puerto');
  assert.strictEqual(p.monto, 976);
  assert.deepStrictEqual(p.lineas.map(l => l.id), ['saldo_proveedor', 'puerto']);
});

test('el resumen del contenedor: las 3 PIs, sus llegadas calculadas y USD 557,70 a pagar', () => {
  const tracking = { eta: '2026-12-26', importaciones: [
    { id: 'IMP-13772', llegada_calculada: '2026-12-12', descripcion: 'Accesorios para moto' },
    { id: 'IMP-14175', llegada_calculada: '2027-01-02' },
    { id: 'IMP-14713', pi: '14713', llegada_calculada: '2027-01-15' },
  ] };
  const r = TC.resumenContenedor(tracking, [IMP_13772, IMP_14175, IMP_14713]);
  assert.strictEqual(r.pendiente, 557.7);
  assert.strictEqual(r.conSaldo, 2);
  assert.deepStrictEqual(r.pis.map(p => [p.pi, p.difDias, p.pendiente.monto]), [
    ['13772', 14, 0], ['14175', -7, 345.5], ['14713', -20, 212.2],
  ]);
  assert.deepStrictEqual(r.calculadas, ['2026-12-12', '2027-01-02', '2027-01-15']);
  assert.ok(r.desfasadas);
  assert.strictEqual(r.pis[0].descripcion, 'Accesorios para moto');
});

test('el número de PI sale de lo cargado en el contenedor o de las notas', () => {
  assert.strictEqual(TC.piDe({ notas: 'PI14175' }), '14175');
  assert.strictEqual(TC.piDe({ notas: 'PI.13772 accesorios' }), '13772');
  assert.strictEqual(TC.piDe({ notas: 'Exhausts Apollo Yi, PI9641.' }), '9641');
  assert.strictEqual(TC.piDe({ notas: 'PI 261107001 de Guangzhou' }), '261107001');
  assert.strictEqual(TC.piDe({ notas: 'Pidió más rojo' }), null);
  assert.strictEqual(TC.piDe({ notas: 'PI1' }, { pi: '14713' }), '14713');
});

// ── Consulta a PIL ───────────────────────────────────────────────────────────
function fetchPIL(respuestaTracking) {
  const pedidos = [];
  const f = async (url, opts) => {
    pedidos.push({ url: String(url), headers: opts?.headers || {} });
    if (String(url).includes('get-n.php')) return new Response(JSON.stringify({ success: true, n: '123|abc' }));
    return new Response(typeof respuestaTracking === 'string' ? respuestaTracking : JSON.stringify(respuestaTracking));
  };
  f.pedidos = pedidos;
  return f;
}

test('la consulta a PIL pide el token, manda el Referer y lee el tracking', async () => {
  const f = fetchPIL(RESPUESTA_PIL);
  const r = await consultarPIL('PCIU 891912-8', { fetch: f, ahora: 1 });
  assert.strictEqual(r.eventos.length, 6);
  assert.strictEqual(f.pedidos.length, 2);
  assert.match(f.pedidos[1].url, /trackntrace-containertnt\.php\?module=TrackContStatus&refNo=PCIU8919128&n=123%7Cabc&timestamp=1$/);
  assert.ok(f.pedidos.every(p => p.headers.Referer === REFERER), 'sin Referer el firewall de PIL rechaza el pedido');
});

test('un contenedor que PIL no conoce y un rechazo del firewall se distinguen', async () => {
  await assert.rejects(consultarPIL('PCIU8919129', { fetch: fetchPIL({ error: true, data: 'No data found for Container Number <b>PCIU8919129</b>.' }) }),
    e => e.codigo === 'sin_datos' && /todavía no tiene datos del contenedor PCIU8919129/.test(e.message));
  await assert.rejects(consultarPIL('PCIU8919128', { fetch: fetchPIL('<html><head><title>Request Rejected</title></head><body>Your support ID is b5da6039-5cf4</body></html>') }),
    e => e.codigo === 'rechazada' && /support ID b5da6039-5cf4/.test(e.message));
  const caido = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await assert.rejects(consultarPIL('PCIU8919128', { fetch: caido }), e => e.codigo === 'red' && /no respondió a tiempo/.test(e.message));
});

// ── Aviso de Telegram ────────────────────────────────────────────────────────
test('el aviso dice cuánto se corrió el arribo, qué PIs trae y cuánto falta pagar', () => {
  const tracking = { contenedor: 'PCIU8919128', naviera: 'PIL', puerto_destino: 'MONTEVIDEO', puerto_origen: 'NINGBO', buque: 'COSCO SHIPPING RHINE',
    estado: 'navegando', eta: '2026-12-30',
    importaciones: [{ id: 'IMP-13772' }, { id: 'IMP-14175' }, { id: 'IMP-14713', pi: '14713' }] };
  const nov = { etaAntes: '2026-12-26', etaNueva: '2026-12-30', cambioEta: true, estadoAntes: 'terminal', estadoNuevo: 'navegando', cambioEstado: true };
  const txt = mensajeNovedades(tracking, nov, [IMP_13772, IMP_14175, IMP_14713],
    [{ id: 'P-TOM', nombre: 'Tom Banana' }, { id: 'P-APOLLO', nombre: 'Apollo Yi' }]);
  assert.match(txt, /Contenedor PCIU 891912-8/);
  assert.match(txt, /Zarpó de Ningbo en el COSCO SHIPPING RHINE/);
  assert.match(txt, /pasó del 26\/12\/2026 al <b>30\/12\/2026<\/b> \(4 días después\)/);
  assert.match(txt, /PI 13772 \(Tom Banana\), PI 14175 \(Apollo Yi\), PI 14713\./);
  assert.match(txt, /falta abonar <b>USD 557\.70<\/b>/);
});

test('sin cambio de arribo ni de una etapa importante no se avisa', () => {
  const t = { contenedor: 'PCIU8919128', naviera: 'PIL', eta: '2026-12-26', estado: 'terminal' };
  assert.strictEqual(mensajeNovedades(t, { cambioEta: false, cambioEstado: false, estadoNuevo: 'terminal' }), null);
  assert.strictEqual(mensajeNovedades(t, { cambioEta: false, cambioEstado: true, estadoAntes: 'origen', estadoNuevo: 'terminal' }), null,
    'entrar a la terminal de origen no es noticia');
  assert.match(mensajeNovedades({ ...t, estado: 'en_puerto', puerto_destino: 'MONTEVIDEO' },
    { cambioEta: false, cambioEstado: true, estadoAntes: 'navegando', estadoNuevo: 'en_puerto' }), /Llegó al puerto de Montevideo/);
});

test('aplicar una consulta guarda movimientos y etapa, y anota el arribo sólo si cambió', () => {
  const ahora = '2026-11-19T10:00:00.000Z';
  const base = { eta: '2026-12-26', estado: 'terminal', eta_historial: [{ eta: '2026-12-26', desde: 'x', fuente: 'manual' }] };
  const igual = aplicarConsulta(base, PIL, { ahora });
  assert.strictEqual(igual.cambios.eventos.length, 6);
  assert.strictEqual(igual.cambios.consultado_at, ahora);
  assert.strictEqual(igual.cambios.eta_historial, undefined, 'mismo arribo: el historial no se toca');
  assert.ok(!igual.novedades.cambioEta && !igual.novedades.cambioEstado);

  const corrido = aplicarConsulta(base, { ...PIL, eventos: avanzar(2, { eta: '2026-12-30' }) }, { ahora });
  assert.strictEqual(corrido.cambios.eta, '2026-12-30');
  assert.strictEqual(corrido.cambios.estado, 'navegando');
  assert.deepStrictEqual(corrido.cambios.eta_historial.map(h => [h.eta, h.fuente]), [['2026-12-26', 'manual'], ['2026-12-30', 'PIL']]);
  assert.ok(corrido.novedades.cambioEta && corrido.novedades.cambioEstado);
});

test('lo que se guarda de un contenedor: número normalizado, links seguros y PIs sin repetir', () => {
  const f = normalizarTracking({
    naviera: 'msc', contenedor: 'mscu 123456-6', link_seguimiento: 'javascript:alert(1)', estado: 'volando',
    importaciones: ['IMP1', { id: 'IMP1' }, { id: 'IMP2', pi: 'PI 14175', llegada_calculada: '2027-01-02T00:00:00' }],
  });
  assert.strictEqual(f.naviera, 'MSC');
  assert.strictEqual(f.contenedor, 'MSCU1234566');
  assert.match(f.link_seguimiento, /^https:\/\//);
  assert.strictEqual(f.estado, 'reservado');
  assert.strictEqual(f.puerto_destino, 'MONTEVIDEO');
  assert.deepStrictEqual(f.importaciones, [
    { id: 'IMP1', pi: null, descripcion: null, llegada_calculada: null },
    { id: 'IMP2', pi: '14175', descripcion: null, llegada_calculada: '2027-01-02' },
  ]);
  assert.deepStrictEqual(normalizarTracking({ notas: 'x' }, { parcial: true }), { notas: 'x' }, 'el PUT sólo toca lo que viene');
});

// ── /api/tracking y el cron con un Supabase falso ────────────────────────────
function supabaseFalso(db, { sinTabla = false } = {}) {
  const ejecutar = q => {
    if (sinTabla && q.tabla === 'trackings') {
      return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.trackings' in the schema cache" } };
    }
    const tabla = db[q.tabla] = db[q.tabla] || [];
    const pasa = r => q.filtros.every(f => f(r));
    let filas;
    if (q.op === 'insert') { tabla.push(JSON.parse(JSON.stringify(q.fila))); filas = [tabla[tabla.length - 1]]; }
    else if (q.op === 'update') { filas = tabla.filter(pasa); filas.forEach(r => Object.assign(r, JSON.parse(JSON.stringify(q.fila)))); }
    else if (q.op === 'delete') { filas = tabla.filter(pasa); db[q.tabla] = tabla.filter(r => !pasa(r)); }
    else filas = tabla.filter(pasa);
    const copia = r => JSON.parse(JSON.stringify(r));
    if (q.single && !filas[0]) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return { data: q.single ? copia(filas[0]) : filas.map(copia), error: null };
  };
  return {
    from(tabla) {
      const q = { tabla, op: 'select', filtros: [], fila: null, single: false };
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => { q.filtros.push(r => r[c] === v); return b; },
        neq: (c, v) => { q.filtros.push(r => r[c] !== v); return b; },
        in: (c, vs) => { q.filtros.push(r => vs.includes(r[c])); return b; },
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

let supabaseActual = null;
require.cache[require.resolve(path.join(__dirname, '../api/_supabase'))] = { exports: { getSupabase: () => supabaseActual } };
const handler = require('../api/tracking');
const cron = require('../api/cron/tracking');

async function llamar(fn, { method = 'GET', query = {}, body, headers = {} } = {}) {
  const res = {
    code: 200, body: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(d) { this.body = d; return this; }, end() { return this; },
  };
  await fn({ method, query, body, headers }, res);
  return res;
}

// fetch global falso: PIL responde `pil` (o lo que se le cambie) y Telegram guarda los mensajes.
let fetchOriginal;
let red;
beforeEach(() => {
  fetchOriginal = globalThis.fetch;
  red = { pil: RESPUESTA_PIL, telegram: [] };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) { red.telegram.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ ok: true, result: {} })); }
    if (u.includes('get-n.php')) return new Response(JSON.stringify({ success: true, n: '1|x' }));
    if (u.includes('trackntrace-containertnt.php')) return new Response(JSON.stringify(red.pil));
    throw new Error('fetch inesperado a ' + u);
  };
  process.env.TELEGRAM_BOT_TOKEN = 'token';
  process.env.TELEGRAM_CHAT_ID = '1';
  process.env.CRON_SECRET = 'secreto';
});
afterEach(() => { globalThis.fetch = fetchOriginal; });

function baseDatos() {
  const puerto = { id: 'IMP-GRUPORAS', fecha: '2026-11-11', llegada: '2027-01-25', estado: 'ordered', proveedor_id: 'P-TOM',
    costo_puerto: 1524.9, traslado: 21.1, nacional: 0, items: [{ sku: 'X', qty: 1, costo: 1128.9 }] };
  puerto.pagos = CI.armarPagos(puerto, [{ id: 'anticipo', pagado: true, fecha_pago: '2026-11-11' }]);
  return {
    importaciones: [
      JSON.parse(JSON.stringify(IMP_13772)), JSON.parse(JSON.stringify(IMP_14175)), JSON.parse(JSON.stringify(IMP_14713)), puerto,
      { id: 'IMP-VIEJA', fecha: '2026-06-01', llegada: '2026-09-01', estado: 'recibido', items: [] },
    ],
    proveedores: [{ id: 'P-TOM', nombre: 'Tom Banana' }, { id: 'P-APOLLO', nombre: 'Apollo Yi' }, { id: 'P-MUXUAN', nombre: 'Guangzhou Muxuan Trading' }],
    trackings: [],
  };
}

test('cargar el contenedor lo consulta en PIL, guarda lo calculado y pasa la llegada de sus PIs al arribo', async () => {
  const db = baseDatos();
  supabaseActual = supabaseFalso(db);
  const r = await llamar(handler, { method: 'POST', body: {
    naviera: 'PIL', contenedor: 'pciu 891912-8',
    importaciones: [{ id: 'IMP-13772', descripcion: 'Accesorios para moto' }, { id: 'IMP-14175' }, { id: 'IMP-14713', pi: '14713' }, { id: 'IMP-GRUPORAS' }, { id: 'IMP-VIEJA' }],
  } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const t = db.trackings[0];
  assert.strictEqual(t.contenedor, 'PCIU8919128');
  assert.strictEqual(t.estado, 'terminal');
  assert.strictEqual(t.eta, '2026-12-26');
  assert.strictEqual(t.buque, 'COSCO SHIPPING RHINE');
  assert.strictEqual(t.eventos.length, 6);
  assert.strictEqual(r.body.consulta.error, null);
  assert.deepStrictEqual(t.importaciones.map(v => [v.id, v.llegada_calculada]), [
    ['IMP-13772', '2026-12-12'], ['IMP-14175', '2027-01-02'], ['IMP-14713', '2027-01-15'], ['IMP-GRUPORAS', '2027-01-25'], ['IMP-VIEJA', '2026-09-01'],
  ], 'la llegada que se había calculado queda guardada antes de moverla');

  const imp = id => db.importaciones.find(i => i.id === id);
  for (const id of ['IMP-13772', 'IMP-14175', 'IMP-14713', 'IMP-GRUPORAS']) assert.strictEqual(imp(id).llegada, '2026-12-26', id);
  assert.strictEqual(imp('IMP-VIEJA').llegada, '2026-09-01', 'una importación que ya llegó no se toca');
  assert.strictEqual(imp('IMP-14175').estado, 'ordered', 'en la terminal de origen todavía no está en tránsito');
  // Con puesta en puerto, el pago al importador vence al arribo y lo marcado se conserva.
  assert.strictEqual(imp('IMP-GRUPORAS').pagos.find(p => p.id === 'puerto').estimado, '2026-12-26');
  assert.ok(imp('IMP-GRUPORAS').pagos.find(p => p.id === 'anticipo').pagado);
  assert.strictEqual(r.body.importaciones_sync.actualizadas.length, 4);
});

test('un número que no es de contenedor no se guarda', async () => {
  supabaseActual = supabaseFalso(baseDatos());
  const r = await llamar(handler, { method: 'POST', body: { naviera: 'PIL', contenedor: 'PCIU891' } });
  assert.strictEqual(r.code, 400);
  assert.match(r.body.error, /4 letras y 7 números/);
});

test('si PIL falla, el contenedor se guarda igual con el error a la vista', async () => {
  const db = baseDatos();
  supabaseActual = supabaseFalso(db);
  red.pil = { error: true, data: 'No data found for Container Number <b>PCIU8919128</b>.' };
  const r = await llamar(handler, { method: 'POST', body: { naviera: 'PIL', contenedor: 'PCIU8919128', eta: '2026-12-20', importaciones: ['IMP-14175'] } });
  assert.strictEqual(r.code, 200);
  assert.match(r.body.consulta.error, /todavía no tiene datos/);
  assert.match(db.trackings[0].consulta_error, /todavía no tiene datos/);
  assert.strictEqual(db.trackings[0].eta, '2026-12-20', 'queda el arribo que se cargó a mano');
  assert.strictEqual(db.importaciones.find(i => i.id === 'IMP-14175').llegada, '2026-12-20');
});

test('volver a consultar anota el arribo nuevo y mueve las PIs: zarpó → en tránsito, llegó → en aduana', async () => {
  const db = baseDatos();
  supabaseActual = supabaseFalso(db);
  await llamar(handler, { method: 'POST', body: { naviera: 'PIL', contenedor: 'PCIU8919128', importaciones: ['IMP-14175', 'IMP-14713'] } });
  const id = db.trackings[0].id;

  red.pil = { success: true, data: RESPUESTA_PIL.data.replace('* 21-Nov-2026 12:00:00', '21-Nov-2026 12:00:00').replace(/26-Dec-2026/g, '30-Dec-2026') };
  const r = await llamar(handler, { method: 'POST', query: { accion: 'actualizar', id } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.estado, 'navegando');
  assert.strictEqual(r.body.eta, '2026-12-30');
  assert.deepStrictEqual(r.body.eta_historial.map(h => h.eta), ['2026-12-26', '2026-12-30']);
  assert.ok(r.body.consulta.novedades.cambioEta);
  const imp = i => db.importaciones.find(x => x.id === i);
  assert.strictEqual(imp('IMP-14175').estado, 'in_transit');
  assert.strictEqual(imp('IMP-14175').llegada, '2026-12-30');

  red.pil = { success: true, data: red.pil.data.replace('* 30-Dec-2026 11:00:00', '30-Dec-2026 09:40:00') };
  const llegado = await llamar(handler, { method: 'POST', query: { accion: 'actualizar', id } });
  assert.strictEqual(llegado.body.estado, 'en_puerto');
  assert.strictEqual(imp('IMP-14175').estado, 'en_aduana');
  assert.strictEqual(imp('IMP-14713').estado, 'en_aduana');
  assert.ok(!db.importaciones.some(i => i.id !== 'IMP-VIEJA' && i.estado === 'recibido'), 'nunca se marca como llegada: eso suma stock y es a mano');
});

test('una naviera sin consulta automática se maneja a mano y anota cada arribo', async () => {
  const db = baseDatos();
  supabaseActual = supabaseFalso(db);
  const r = await llamar(handler, { method: 'POST', body: { naviera: 'MSC', contenedor: 'MSCU1234566', eta: '2027-01-10', estado: 'navegando', importaciones: ['IMP-13772'] } });
  assert.strictEqual(r.body.consulta, null, 'no se consulta ninguna web');
  assert.strictEqual(db.importaciones.find(i => i.id === 'IMP-13772').estado, 'in_transit');
  const id = db.trackings[0].id;
  const r2 = await llamar(handler, { method: 'PUT', query: { id }, body: { eta: '2027-01-14' } });
  assert.deepStrictEqual(r2.body.eta_historial.map(h => [h.eta, h.fuente]), [['2027-01-10', 'manual'], ['2027-01-14', 'manual']]);
  assert.strictEqual(db.importaciones.find(i => i.id === 'IMP-13772').llegada, '2027-01-14');
  const r3 = await llamar(handler, { method: 'POST', query: { accion: 'actualizar', id } });
  assert.strictEqual(r3.code, 400);
  assert.match(r3.body.error, /no se consulta sola/);
});

test('sumar una PI después conserva lo calculado de las que ya estaban', async () => {
  const db = baseDatos();
  supabaseActual = supabaseFalso(db);
  await llamar(handler, { method: 'POST', body: { naviera: 'PIL', contenedor: 'PCIU8919128', importaciones: ['IMP-14175'] } });
  const id = db.trackings[0].id;
  // La 14175 ya tiene la llegada del contenedor; lo que se había calculado no se pisa con eso.
  await llamar(handler, { method: 'PUT', query: { id }, body: { importaciones: [{ id: 'IMP-14175' }, { id: 'IMP-14713' }] } });
  assert.deepStrictEqual(db.trackings[0].importaciones.map(v => [v.id, v.llegada_calculada]),
    [['IMP-14175', '2027-01-02'], ['IMP-14713', '2027-01-15']]);
});

test('sin la migración, la pantalla carga igual y el alta explica qué correr', async () => {
  supabaseActual = supabaseFalso(baseDatos(), { sinTabla: true });
  const g = await llamar(handler, { method: 'GET' });
  assert.deepStrictEqual(g.body, { trackings: [], migracionPendiente: true });
  const p = await llamar(handler, { method: 'POST', body: { naviera: 'PIL', contenedor: 'PCIU8919128' } });
  assert.strictEqual(p.code, 409);
  assert.match(p.body.error, /20261118000000_add_trackings\.sql/);
  const c = await llamar(cron, { headers: { authorization: 'Bearer secreto' } });
  assert.strictEqual(c.body.ok, true);
});

test('el cron consulta lo que está en camino y avisa por Telegram sólo si cambió algo', async () => {
  const db = baseDatos();
  supabaseActual = supabaseFalso(db);
  await llamar(handler, { method: 'POST', body: { naviera: 'PIL', contenedor: 'PCIU8919128', importaciones: [{ id: 'IMP-13772' }, { id: 'IMP-14175' }, { id: 'IMP-14713', pi: '14713' }] } });
  db.trackings.push({ id: 'TRK-VIEJO', naviera: 'PIL', contenedor: 'PCIU1111110', estado: 'retirado', importaciones: [] });
  db.trackings.push({ id: 'TRK-MSC', naviera: 'MSC', contenedor: 'MSCU1234566', estado: 'navegando', importaciones: [] });

  assert.strictEqual((await llamar(cron, { headers: {} })).code, 401);

  const sinCambios = await llamar(cron, { headers: { authorization: 'Bearer secreto' } });
  assert.strictEqual(sinCambios.body.consultados, 1, 'ni el retirado ni el de MSC se consultan');
  assert.strictEqual(red.telegram.length, 0, 'mismo arribo y misma etapa: no se avisa');

  red.pil = { success: true, data: RESPUESTA_PIL.data.replace(/26-Dec-2026/g, '02-Jan-2027') };
  const conCambios = await llamar(cron, { headers: { authorization: 'Bearer secreto' } });
  assert.ok(conCambios.body.resultados[0].avisado);
  assert.strictEqual(red.telegram.length, 1);
  const txt = red.telegram[0].text;
  assert.match(txt, /pasó del 26\/12\/2026 al <b>02\/01\/2027<\/b> \(7 días después\)/);
  assert.match(txt, /PI 13772 \(Tom Banana\), PI 14175 \(Apollo Yi\), PI 14713 \(Guangzhou Muxuan Trading\)/);
  assert.match(txt, /USD 557\.70/);
  assert.strictEqual(db.importaciones.find(i => i.id === 'IMP-14713').llegada, '2027-01-02');
});
