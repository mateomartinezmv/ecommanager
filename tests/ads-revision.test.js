// Revisión semanal de Ads y cola de Telegram, directo sobre api/_adsRevision.js,
// api/_invocar.js y api/_telegramCola.js (sin navegador, MELI ni Telegram).
//
// Lo que se protege:
//  · La semana que se revisa es siempre la última cerrada de lunes a domingo en Montevideo,
//    corra el cron cuando corra, y la anterior es la de antes (para comparar).
//  · Cada parte guarda lo que devuelve el mismo endpoint que usa la pestaña del CRM, sin
//    miniaturas ni links; un endpoint que falla queda anotado, no rompe a las demás.
//  · Promos guarda sólo lo que pide una decisión.
//  · La cola manda cada mensaje una vez, partido si es largo, sin formato si Telegram
//    rechaza el HTML, y reintenta sólo lo que no salió.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

function simular(relativo, exportaciones) {
  const p = path.join(__dirname, '..', relativo);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportaciones };
}

// ── Supabase en memoria ────────────────────────────────────────────────────
function fakeSupabase(tablas) {
  let seq = 1;
  class Q {
    constructor(t) { this.t = t; this.filtros = []; this.op = 'select'; }
    select() { return this; }
    insert(f) { this.op = 'insert'; this.payload = f; return this; }
    update(c) { this.op = 'update'; this.payload = c; return this; }
    upsert(f) { this.op = 'upsert'; this.payload = f; return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    order() { return this; }
    limit(n) { this.tope = n; return this; }
    then(ok, mal) { return Promise.resolve().then(() => this.correr()).then(ok, mal); }
    correr() {
      const filas = (tablas[this.t] ||= []);
      const cumplen = filas.filter(r => this.filtros.every(f => f(r)));
      if (this.op === 'insert') { filas.push({ id: seq++, estado: 'pendiente', intentos: 0, ...this.payload }); return { error: null }; }
      if (this.op === 'upsert') {
        const n = this.payload;
        const i = filas.findIndex(r => r.semana === n.semana && r.parte === n.parte);
        if (i >= 0) filas[i] = { ...filas[i], ...n }; else filas.push({ ...n });
        return { error: null };
      }
      if (this.op === 'update') {
        cumplen.forEach(r => Object.assign(r, this.payload));
        return { data: cumplen.map(r => ({ ...r })), error: null };
      }
      const out = this.tope ? cumplen.slice(0, this.tope) : cumplen;
      return { data: out.map(r => ({ ...r })), error: null };
    }
  }
  return { _tablas: tablas, from: t => new Q(t) };
}

// ── Endpoints del CRM y Telegram simulados ─────────────────────────────────
const llamados = [];
const respuestas = {};
function endpoint(nombre) {
  return async (req, res) => {
    llamados.push({ nombre, query: req.query });
    const r = respuestas[nombre];
    if (r instanceof Error) throw r;
    const data = typeof r === 'function' ? r(req) : (r ?? { ok: true, nombre });
    if (data === undefined) return;          // termina sin responder
    return res.status(data.__status || 200).json(data);
  };
}
for (const n of ['ads-campanas', 'ads-anuncios', 'ads-recomendaciones', 'promos', 'ads-cambios', 'ads-evolucion']) {
  simular(`api/meli/${n}.js`, endpoint(n));
}

const tg = { enviados: [], rechazaHtml: false, caido: false, fallarDesde: Infinity };
simular('api/_telegram.js', {
  esc: s => String(s),
  enviar: async (texto, { html = true } = {}) => {
    if (tg.caido) return null;
    if (html && tg.rechazaHtml) return null;
    if (tg.enviados.length >= tg.fallarDesde) return null;
    tg.enviados.push({ texto, html });
    return { message_id: tg.enviados.length };
  },
});

const { semanaCerrada, aligerar, promosParaRevisar, correrParte } = require('../api/_adsRevision');
const { invocar } = require('../api/_invocar');
const { partir, enviarCola, MAX_INTENTOS } = require('../api/_telegramCola');

beforeEach(() => {
  llamados.length = 0;
  for (const k of Object.keys(respuestas)) delete respuestas[k];
  tg.enviados = []; tg.rechazaHtml = false; tg.caido = false; tg.fallarDesde = Infinity;
});

// ── La semana ──────────────────────────────────────────────────────────────

test('semana: la última cerrada de lunes a domingo, en hora de Montevideo', () => {
  const lunes = semanaCerrada(new Date('2026-11-16T15:00:00Z'));
  assert.deepStrictEqual(lunes, {
    desde: '2026-11-09', hasta: '2026-11-15',
    anterior: { desde: '2026-11-02', hasta: '2026-11-08' },
  });
  assert.deepStrictEqual(semanaCerrada(new Date('2026-11-18T12:00:00Z')), lunes, 'un miércoles da la misma');
  // Domingo 23:30 en Montevideo (lunes 02:30 UTC): la semana todavía no cerró.
  assert.strictEqual(semanaCerrada(new Date('2026-11-16T02:30:00Z')).desde, '2026-11-02');
});

// ── Partes ─────────────────────────────────────────────────────────────────

test('campañas: pide la semana y la anterior al mismo endpoint de la pestaña', async () => {
  const s = fakeSupabase({});
  const r = await correrParte(s, 'campanas', new Date('2026-11-16T15:00:00Z'));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(llamados.map(l => l.query), [
    { desde: '2026-11-09', hasta: '2026-11-15' },
    { desde: '2026-11-02', hasta: '2026-11-08' },
  ]);
  const fila = s._tablas.ads_revision_partes[0];
  assert.strictEqual(fila.semana, '2026-11-09');
  assert.strictEqual(fila.parte, 'campanas');
  assert.ok(fila.datos.semana && fila.datos.anterior);
});

test('anuncios: todas las campañas, sin miniaturas ni links', async () => {
  respuestas['ads-anuncios'] = { ok: true, anuncios: [{ titulo: 'Manillar', thumbnail: 'x.jpg', permalink: 'http://', roas: 3, sub: { permalink: 'y' } }] };
  const s = fakeSupabase({});
  await correrParte(s, 'anuncios', new Date('2026-11-16T15:00:00Z'));
  assert.deepStrictEqual(llamados[0].query, { campaign_id: 'todas', desde: '2026-11-09', hasta: '2026-11-15' });
  assert.deepStrictEqual(s._tablas.ads_revision_partes[0].datos.anuncios, [{ titulo: 'Manillar', roas: 3, sub: {} }]);
});

test('un endpoint que falla queda anotado con su error y no rompe el cron', async () => {
  const s = fakeSupabase({});
  respuestas['ads-recomendaciones'] = { ok: false, error: 'MELI no conectado' };
  const r = await correrParte(s, 'recomendaciones');
  assert.deepStrictEqual([r.ok, r.error], [false, 'MELI no conectado']);

  respuestas.promos = new Error('timeout');
  const r2 = await correrParte(s, 'promos');
  assert.deepStrictEqual([r2.ok, r2.error], [false, 'timeout']);
  assert.strictEqual(s._tablas.ads_revision_partes.length, 2, 'las dos quedaron guardadas');
});

test('volver a correr una parte reemplaza la fila de esa semana', async () => {
  const s = fakeSupabase({});
  respuestas['ads-cambios'] = { ok: true, cambios: [1] };
  await correrParte(s, 'cambios', new Date('2026-11-16T15:00:00Z'));
  respuestas['ads-cambios'] = { ok: true, cambios: [1, 2] };
  await correrParte(s, 'cambios', new Date('2026-11-16T15:05:00Z'));
  assert.strictEqual(s._tablas.ads_revision_partes.length, 1);
  assert.deepStrictEqual(s._tablas.ads_revision_partes[0].datos.cambios.cambios, [1, 2]);
});

test('una parte desconocida es un error claro', async () => {
  await assert.rejects(correrParte(fakeSupabase({}), 'cualquiera'), /Parte desconocida/);
});

test('promos: sólo lo que pide una decisión', () => {
  const r = promosParaRevisar({
    ok: true, reglas: { piso: 2 }, resumen: { propuestas: 1 },
    productos: [
      { sku: 'A', publicaciones: [
        { meli_id: 'M1', propuestas: [{ id: 'P', evaluacion: { veredicto: 'aceptar' } }], permalink: 'x' },
        { meli_id: 'M2', propuestas: [], vigente: null, referencia: null },
      ] },
      { sku: 'B', publicaciones: [{ meli_id: 'M3', propuestas: [], vigente: { evaluacion: { veredicto: 'rechazar' } } }] },
      { sku: 'C', publicaciones: [{ meli_id: 'M4', propuestas: [], referencia: { baja_pct: 8 } }] },
      { sku: 'D', publicaciones: [{ meli_id: 'M5', propuestas: [], vigente: { evaluacion: { veredicto: 'aceptar' } } }] },
    ],
  });
  assert.deepStrictEqual(r.productos.map(p => [p.sku, p.publicaciones.map(x => x.meli_id)]),
    [['A', ['M1']], ['B', ['M3']], ['C', ['M4']]]);
  assert.strictEqual(r.productos[0].publicaciones[0].permalink, undefined);
  assert.deepStrictEqual(r.reglas, { piso: 2 });
});

test('invocar: un handler que termina sin responder no deja la promesa colgada', async () => {
  const r = await invocar(async () => {});
  assert.deepStrictEqual(r, { status: 200, data: null });
  assert.deepStrictEqual(aligerar([{ thumbnail: 1, a: [{ permalink: 2, b: 3 }] }]), [{ a: [{ b: 3 }] }]);
});

// ── Cola de Telegram ───────────────────────────────────────────────────────

test('partir: respeta el tope, corta entre párrafos y no pierde texto', () => {
  const parrafos = Array.from({ length: 30 }, (_, i) => `Párrafo ${i} ` + 'x'.repeat(300));
  const texto = parrafos.join('\n\n');
  const trozos = partir(texto, 1000);
  assert.ok(trozos.length > 1);
  assert.ok(trozos.every(t => t.length <= 1000));
  assert.strictEqual(trozos.join('\n\n'), texto);
  assert.ok(trozos.every(t => t.startsWith('Párrafo')), 'cada mensaje arranca en un párrafo');

  const linea = 'y'.repeat(2500);
  assert.ok(partir(linea, 1000).every(t => t.length <= 1000));
  assert.strictEqual(partir(linea, 1000).join(''), linea);
  assert.deepStrictEqual(partir('corto'), ['corto']);
});

test('cola: manda lo pendiente una vez y lo marca enviado', async () => {
  const s = fakeSupabase({ telegram_cola: [] });
  await s.from('telegram_cola').insert({ texto: '<b>Ads</b> semana' });
  await s.from('telegram_cola').insert({ texto: 'otro' });
  await Promise.all([enviarCola(s), enviarCola(s)]);
  assert.deepStrictEqual(tg.enviados.map(e => e.texto), ['<b>Ads</b> semana', 'otro']);
  assert.ok(s._tablas.telegram_cola.every(f => f.estado === 'enviado' && f.enviado_at));
  await enviarCola(s);
  assert.strictEqual(tg.enviados.length, 2, 'lo enviado no se vuelve a mandar');
});

test('cola: un texto largo sale en varios mensajes', async () => {
  const s = fakeSupabase({ telegram_cola: [] });
  await s.from('telegram_cola').insert({ texto: Array.from({ length: 20 }, () => 'z'.repeat(500)).join('\n\n') });
  await enviarCola(s);
  assert.ok(tg.enviados.length >= 3);
  assert.ok(tg.enviados.every(e => e.texto.length <= 4000));
});

test('cola: si Telegram rechaza el HTML, lo manda sin formato', async () => {
  tg.rechazaHtml = true;
  const s = fakeSupabase({ telegram_cola: [] });
  await s.from('telegram_cola').insert({ texto: '<b>mal cerrado' });
  await enviarCola(s);
  assert.deepStrictEqual(tg.enviados, [{ texto: '<b>mal cerrado', html: false }]);
  assert.strictEqual(s._tablas.telegram_cola[0].estado, 'enviado');
});

test('cola: si Telegram no responde, reintenta y a los 5 intentos se rinde', async () => {
  tg.caido = true;
  const s = fakeSupabase({ telegram_cola: [] });
  await s.from('telegram_cola').insert({ texto: 'hola' });
  for (let i = 1; i < MAX_INTENTOS; i++) {
    await enviarCola(s);
    assert.deepStrictEqual([s._tablas.telegram_cola[0].estado, s._tablas.telegram_cola[0].intentos], ['pendiente', i]);
  }
  await enviarCola(s);
  assert.strictEqual(s._tablas.telegram_cola[0].estado, 'error');

  tg.caido = false;
  await enviarCola(s);
  assert.strictEqual(tg.enviados.length, 0, 'lo que quedó en error no se manda solo');
});

test('cola: si ya salió una parte, no la repite reintentando', async () => {
  tg.fallarDesde = 1;
  const s = fakeSupabase({ telegram_cola: [] });
  await s.from('telegram_cola').insert({ texto: Array.from({ length: 12 }, () => 'w'.repeat(600)).join('\n\n') });
  await enviarCola(s);
  assert.strictEqual(tg.enviados.length, 1);
  assert.strictEqual(s._tablas.telegram_cola[0].estado, 'error');
  assert.match(s._tablas.telegram_cola[0].error, /Se mandaron 1 de/);
  await enviarCola(s);
  assert.strictEqual(tg.enviados.length, 1);
});
