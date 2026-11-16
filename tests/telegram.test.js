// Telegram, directo sobre los módulos de api/ (sin navegador ni red).
//
// Lo que se protege:
//  · Preguntas de MELI: llegan con la respuesta ya redactada y dos botones; Aceptar publica
//    exactamente ese texto una sola vez, Rechazar no publica nada; el mismo aviso de MELI
//    repetido no manda dos mensajes; dos preguntas seguidas no se pisan; si ya se respondió
//    por fuera (MELI o el CRM) el mensaje pierde los botones.
//  · El webhook: sólo el chat del dueño puede tocar los botones, y el bot ya no ejecuta
//    comandos ni texto libre.
//  · MELI notify: el tópico `items` (el aviso de "Publicación pausada") ya no manda nada.
//  · El cron de stock: avisa recién a la tercera corrida seguida fallando, una sola vez.
//  · El resumen diario: día de Uruguay, sin canceladas, con Shopify y sin descatalogados.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ── Supabase en memoria: lo justo de PostgREST que usan estos módulos ──────
const PK = { telegram_preguntas: 'question_id', stock_sync_fallos: 'meli_id' };

function fakeSupabase(tablas, { faltan = [] } = {}) {
  class Q {
    constructor(t) { this.t = t; this.filtros = []; this.op = 'select'; this.unica = false; }
    select() { return this; }
    insert(fila) { this.op = 'insert'; this.payload = fila; return this; }
    update(cambios) { this.op = 'update'; this.payload = cambios; return this; }
    upsert(filas) { this.op = 'upsert'; this.payload = filas; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    in(c, vals) { this.filtros.push(r => vals.includes(r[c])); return this; }
    neq(c, v) { this.filtros.push(r => String(r[c]) !== String(v)); return this; }
    contains(c, vals) { this.filtros.push(r => Array.isArray(r[c]) && vals.every(v => r[c].includes(v))); return this; }
    limit(n) { this.tope = n; return this; }
    maybeSingle() { this.unica = true; return this; }
    then(ok, mal) { return Promise.resolve().then(() => this.correr()).then(ok, mal); }
    correr() {
      if (faltan.includes(this.t)) {
        return { data: null, error: { code: '42P01', message: `relation "${this.t}" does not exist` } };
      }
      const filas = (tablas[this.t] ||= []);
      const pk = PK[this.t];
      const cumplen = filas.filter(r => this.filtros.every(f => f(r)));
      if (this.op === 'insert') {
        if (filas.some(r => r[pk] === this.payload[pk])) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        filas.push({ ...this.payload });
        return { data: null, error: null };
      }
      if (this.op === 'upsert') {
        for (const nueva of [].concat(this.payload)) {
          const i = filas.findIndex(r => r[pk] === nueva[pk]);
          if (i >= 0) filas[i] = { ...filas[i], ...nueva }; else filas.push({ ...nueva });
        }
        return { data: null, error: null };
      }
      if (this.op === 'update') {
        cumplen.forEach(r => Object.assign(r, this.payload));
        return { data: cumplen.map(r => ({ ...r })), error: null };
      }
      if (this.op === 'delete') {
        tablas[this.t] = filas.filter(r => !cumplen.includes(r));
        return { data: null, error: null };
      }
      if (this.unica) return { data: cumplen[0] ? { ...cumplen[0] } : null, error: null };
      const filasOk = this.tope ? cumplen.slice(0, this.tope) : cumplen;
      return { data: filasOk.map(r => ({ ...r })), error: null };
    }
  }
  return { _tablas: tablas, from: t => new Q(t) };
}

// ── Telegram, MELI y Supabase simulados ────────────────────────────────────
const tg = { enviados: [], editados: [], botones: [], proximoId: 100 };
const meli = { preguntas: {}, publicadas: [], fallaPublicar: null, fallaLeer: null, borrador: null, stocks: [] };
let supa = fakeSupabase({});

function simular(relativo, exportaciones) {
  const p = path.join(__dirname, '..', relativo);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportaciones };
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
simular('api/_telegram.js', {
  esc,
  enviar: async (texto, { botones } = {}) => {
    const m = { message_id: tg.proximoId++, texto, botones: botones || null };
    tg.enviados.push(m);
    return m;
  },
  editar: async (messageId, texto, { botones } = {}) => { tg.editados.push({ messageId, texto, botones: botones || null }); return {}; },
  responderBoton: async (id, texto) => { tg.botones.push({ id, texto: texto || null }); return true; },
});
simular('api/_meliToken.js', { getMeliToken: async () => 'tok' });
simular('api/_meliPreguntas.js', {
  MAX_RESPUESTA: 2000,
  obtenerPregunta: async (token, id) => {
    if (meli.fallaLeer) throw new Error(meli.fallaLeer);
    const q = meli.preguntas[String(id)];
    if (!q) throw new Error(`MELI /questions/${id}: not_found`);
    return { ...q };
  },
  titulosDeItems: async (token, ids) => Object.fromEntries(ids.map(id => [id, `Título de ${id}`])),
  redactarRespuesta: async (token, q, titulo, { stock } = {}) => {
    meli.stocks.push(stock);
    if (meli.borrador) return meli.borrador(q);
    return { texto: `Hola, sí: ${q.text}\n\nSaludos, Mateo de Martinez Motos`, primeraPregunta: true };
  },
  responderPregunta: async (token, id, texto) => {
    if (meli.fallaPublicar) throw new Error(meli.fallaPublicar);
    meli.publicadas.push({ id: String(id), texto });
    meli.preguntas[String(id)].status = 'ANSWERED';
    return { ok: true };
  },
});
simular('api/_supabase.js', { getSupabase: () => supa });

const { avisarPregunta, resolverBoton, marcarRespondidaFuera } = require('../api/_telegramPreguntas');
const webhook = require('../api/telegram/webhook');
const notify = require('../api/meli/notify');
const { contarFallos, registrarFallos } = require('../api/_fallosStock');
const { armarResumen, hoyEnUruguay, diaAnterior, stockDeLoVendido } = require('../api/cron/resumen-diario');

const CHAT = '555';
process.env.TELEGRAM_CHAT_ID = CHAT;

beforeEach(() => {
  tg.enviados = []; tg.editados = []; tg.botones = [];
  meli.preguntas = {}; meli.publicadas = []; meli.fallaPublicar = null; meli.fallaLeer = null; meli.borrador = null; meli.stocks = [];
  supa = fakeSupabase({});
});

const nuevaPregunta = (id, text = '¿Sirve para una Honda Wave?') => {
  meli.preguntas[id] = { id: Number(id), status: 'UNANSWERED', item_id: 'MLU1', text };
};
const fila = id => supa._tablas.telegram_preguntas.find(f => f.question_id === String(id));
const tocar = (data, chat = CHAT) => ({
  id: `cb-${Math.random()}`, data, message: { message_id: fila(data.split(':')[2])?.message_id, chat: { id: Number(chat) } },
});

// ── Preguntas ──────────────────────────────────────────────────────────────

test('una pregunta nueva llega con la respuesta lista y los botones Aceptar / Rechazar', async () => {
  nuevaPregunta('111');
  const r = await avisarPregunta(supa, '111');

  assert.strictEqual(r.estado, 'pendiente');
  assert.strictEqual(tg.enviados.length, 1);
  const m = tg.enviados[0];
  assert.match(m.texto, /Nueva pregunta en MELI/);
  assert.match(m.texto, /Título de MLU1/);
  assert.match(m.texto, /¿Sirve para una Honda Wave\?/);
  assert.match(m.texto, /Respuesta sugerida/);
  assert.deepStrictEqual(m.botones, [[
    { text: '✅ Aceptar', callback_data: 'pq:ok:111' },
    { text: '❌ Rechazar', callback_data: 'pq:no:111' },
  ]]);
  assert.strictEqual(fila('111').estado, 'pendiente');
  assert.strictEqual(fila('111').message_id, m.message_id);
  assert.strictEqual(meli.publicadas.length, 0, 'avisar no publica nada');
});

test('la respuesta se redacta con el stock del CRM y el mensaje muestra qué dato usó', async () => {
  supa._tablas.productos = [
    { sku: 'MAN-22MM-ROJO', nombre: 'Manillar 22mm Rojo', stock_dep: 0, unidades_por_venta: 1, discontinuado: false, meli_ids: ['MLU1'] },
  ];
  supa._tablas.importaciones = [];
  nuevaPregunta('150', '¿Tenés stock?');
  await avisarPregunta(supa, '150');
  assert.strictEqual(meli.stocks[0].estado, 'sin_stock', 'la IA recibe que no hay stock');
  assert.match(tg.enviados[0].texto, /Stock CRM:<\/b> sin stock/);
  assert.match(fila('150').stock_crm, /sin stock/);

  await resolverBoton(supa, tocar('pq:no:150'));
  assert.match(tg.editados.at(-1).texto, /Stock CRM:<\/b> sin stock/, 'la línea sigue al editar el mensaje');
});

test('una publicación sin vincular al CRM se avisa como tal', async () => {
  supa._tablas.productos = [];
  nuevaPregunta('160');
  await avisarPregunta(supa, '160');
  assert.strictEqual(meli.stocks[0].estado, 'sin_vincular');
  assert.match(tg.enviados[0].texto, /no está vinculada a ningún producto/);
});

test('el mismo aviso de MELI repetido (incluso a la vez) manda un solo mensaje', async () => {
  nuevaPregunta('222');
  await Promise.all([avisarPregunta(supa, '222'), avisarPregunta(supa, '222'), avisarPregunta(supa, '222')]);
  await avisarPregunta(supa, '222');
  assert.strictEqual(tg.enviados.length, 1);
});

test('dos preguntas seguidas no se pisan: cada una publica su propia respuesta', async () => {
  nuevaPregunta('301', '¿Tienen en rojo?');
  nuevaPregunta('302', '¿Hacen envíos a Salto?');
  await avisarPregunta(supa, '301');
  await avisarPregunta(supa, '302');
  assert.strictEqual(tg.enviados.length, 2);

  await resolverBoton(supa, tocar('pq:ok:301'));
  assert.deepStrictEqual(meli.publicadas.map(p => p.id), ['301']);
  assert.match(meli.publicadas[0].texto, /¿Tienen en rojo\?/);
  assert.strictEqual(fila('302').estado, 'pendiente', 'la otra sigue esperando');
});

test('Aceptar publica exactamente el texto sugerido, una sola vez, y saca los botones', async () => {
  nuevaPregunta('400');
  await avisarPregunta(supa, '400');
  const sugerida = fila('400').respuesta;

  const r = await resolverBoton(supa, tocar('pq:ok:400'));
  assert.strictEqual(r.estado, 'publicada');
  assert.deepStrictEqual(meli.publicadas, [{ id: '400', texto: sugerida }]);
  assert.strictEqual(fila('400').estado, 'publicada');
  const ed = tg.editados.at(-1);
  assert.strictEqual(ed.messageId, fila('400').message_id);
  assert.match(ed.texto, /Publicada en MELI/);
  assert.strictEqual(ed.botones, null, 'el mensaje queda sin botones');

  const otra = await resolverBoton(supa, tocar('pq:ok:400'));
  assert.strictEqual(otra.estado, 'ya_resuelta');
  assert.strictEqual(meli.publicadas.length, 1, 'tocar de nuevo no vuelve a publicar');
});

test('dos toques de Aceptar a la vez publican una sola vez', async () => {
  nuevaPregunta('401');
  await avisarPregunta(supa, '401');
  await Promise.all([resolverBoton(supa, tocar('pq:ok:401')), resolverBoton(supa, tocar('pq:ok:401'))]);
  assert.strictEqual(meli.publicadas.length, 1);
});

test('Rechazar no publica nada y lo deja anotado', async () => {
  nuevaPregunta('500');
  await avisarPregunta(supa, '500');
  const r = await resolverBoton(supa, tocar('pq:no:500'));
  assert.strictEqual(r.estado, 'rechazada');
  assert.strictEqual(meli.publicadas.length, 0);
  assert.strictEqual(fila('500').estado, 'rechazada');
  assert.match(tg.editados.at(-1).texto, /Rechazada/);

  await resolverBoton(supa, tocar('pq:ok:500'));
  assert.strictEqual(meli.publicadas.length, 0, 'después de rechazar, Aceptar ya no publica');
});

test('si ya se respondió desde MELI, Aceptar no publica una segunda respuesta', async () => {
  nuevaPregunta('600');
  await avisarPregunta(supa, '600');
  meli.preguntas['600'].status = 'ANSWERED';
  const r = await resolverBoton(supa, tocar('pq:ok:600'));
  assert.strictEqual(r.estado, 'respondida_fuera');
  assert.strictEqual(meli.publicadas.length, 0);
  assert.match(tg.editados.at(-1).texto, /Ya estaba respondida/);
});

test('si MELI rechaza la respuesta, avisa y el botón sirve para reintentar', async () => {
  nuevaPregunta('700');
  await avisarPregunta(supa, '700');
  meli.fallaPublicar = 'invalid_text';
  const r = await resolverBoton(supa, tocar('pq:ok:700'));
  assert.strictEqual(r.estado, 'error');
  assert.strictEqual(fila('700').estado, 'pendiente');
  assert.match(tg.enviados.at(-1).texto, /No se pudo publicar/);
  assert.match(tg.enviados.at(-1).texto, /invalid_text/);

  meli.fallaPublicar = null;
  assert.strictEqual((await resolverBoton(supa, tocar('pq:ok:700'))).estado, 'publicada');
  assert.strictEqual(meli.publicadas.length, 1);
});

test('si no se pudo redactar, avisa la pregunta sin botones', async () => {
  nuevaPregunta('800');
  meli.borrador = () => { const e = new Error('sin key'); e.code = 'SIN_API_KEY'; throw e; };
  const r = await avisarPregunta(supa, '800');
  assert.strictEqual(r.estado, 'sin_borrador');
  assert.strictEqual(tg.enviados[0].botones, null);
  assert.match(tg.enviados[0].texto, /Respondela desde MELI/);
});

test('si MELI no contesta al leer la pregunta, el próximo aviso todavía puede avisar', async () => {
  nuevaPregunta('900');
  meli.fallaLeer = 'timeout';
  await assert.rejects(avisarPregunta(supa, '900'));
  assert.strictEqual(tg.enviados.length, 0);
  meli.fallaLeer = null;
  assert.strictEqual((await avisarPregunta(supa, '900')).estado, 'pendiente');
  assert.strictEqual(tg.enviados.length, 1);
});

test('una pregunta que ya no está sin responder no se avisa', async () => {
  nuevaPregunta('950');
  meli.preguntas['950'].status = 'ANSWERED';
  assert.strictEqual((await avisarPregunta(supa, '950')).estado, 'no_pendiente');
  assert.strictEqual(tg.enviados.length, 0);
});

test('respondida desde el CRM: el mensaje de Telegram pierde los botones', async () => {
  nuevaPregunta('1000');
  await avisarPregunta(supa, '1000');
  assert.strictEqual(await marcarRespondidaFuera(supa, '1000', 'desde el CRM'), true);
  assert.strictEqual(fila('1000').estado, 'respondida_fuera');
  assert.match(tg.editados.at(-1).texto, /Respondida desde el CRM/);
  assert.strictEqual(tg.editados.at(-1).botones, null);
  await resolverBoton(supa, tocar('pq:ok:1000'));
  assert.strictEqual(meli.publicadas.length, 0);
});

test('un aviso repetido de una pregunta respondida desde MELI le saca los botones', async () => {
  nuevaPregunta('1100');
  await avisarPregunta(supa, '1100');
  meli.preguntas['1100'].status = 'ANSWERED';
  await avisarPregunta(supa, '1100');
  assert.strictEqual(fila('1100').estado, 'respondida_fuera');
  assert.match(tg.editados.at(-1).texto, /Respondida desde MELI/);
  assert.strictEqual(tg.enviados.length, 1);
});

// ── Webhook de Telegram ────────────────────────────────────────────────────

function llamar(handler, body) {
  return new Promise(resolve => {
    const res = { status() { return this; }, json(d) { resolve(d); return this; } };
    handler({ method: 'POST', body, headers: {} }, res);
  });
}

test('webhook: el botón del chat del dueño publica; el de otro chat no hace nada', async () => {
  nuevaPregunta('1200');
  await avisarPregunta(supa, '1200');

  await llamar(webhook, { callback_query: tocar('pq:ok:1200', '999') });
  assert.strictEqual(meli.publicadas.length, 0, 'otro chat no puede publicar');

  await llamar(webhook, { callback_query: tocar('pq:ok:1200') });
  assert.strictEqual(meli.publicadas.length, 1);
});

test('webhook: el bot ya no ejecuta comandos ni texto libre, sólo explica qué hace', async () => {
  for (const text of ['stock', 'ventas hoy', 'vendí 2 señaleros a $1500 efectivo', 'ok']) {
    await llamar(webhook, { message: { text, chat: { id: Number(CHAT) } } });
  }
  assert.strictEqual(tg.enviados.length, 4);
  for (const m of tg.enviados) assert.match(m.texto, /Este bot sólo avisa/);
  assert.deepStrictEqual(Object.keys(supa._tablas), [], 'no tocó ninguna tabla');

  await llamar(webhook, { message: { text: 'hola', chat: { id: 999 } } });
  assert.strictEqual(tg.enviados.length, 4, 'a otro chat no le contesta');
});

// ── MELI notify ────────────────────────────────────────────────────────────

test('notify: el aviso de "Publicación pausada" ya no existe', async () => {
  const llamadas = [];
  const fetchOriginal = global.fetch;
  global.fetch = async (url) => { llamadas.push(String(url)); throw new Error('no debería llamar'); };
  try {
    await llamar(notify, { topic: 'items', resource: '/items/MLU1228726444' });
  } finally {
    global.fetch = fetchOriginal;
  }
  assert.deepStrictEqual(llamadas, [], 'ni siquiera consulta la publicación');
  assert.strictEqual(tg.enviados.length, 0);
});

test('notify: una pregunta entra por el flujo nuevo con botones', async () => {
  nuevaPregunta('1300');
  await llamar(notify, { topic: 'questions', resource: '/questions/1300' });
  assert.strictEqual(tg.enviados.length, 1);
  assert.ok(tg.enviados[0].botones);
});

// ── Cron de stock ──────────────────────────────────────────────────────────

test('stock: avisa recién a la tercera corrida seguida fallando y una sola vez', () => {
  const falla = [{ sku: 'S1', meli_id: 'MLU9', titulo: 'Espejo', error: 'item.status.invalid' }];
  let tabla = [];
  const correr = fallidas => {
    const r = contarFallos(tabla, fallidas);
    tabla = r.filas;
    return r;
  };
  assert.strictEqual(correr(falla).avisar.length, 0);
  assert.strictEqual(correr(falla).avisar.length, 0);
  const tercera = correr(falla);
  assert.strictEqual(tercera.avisar.length, 1);
  assert.strictEqual(tercera.avisar[0].meli_id, 'MLU9');
  assert.strictEqual(correr(falla).avisar.length, 0, 'la cuarta hora ya no avisa');

  const destrabada = contarFallos(tabla, []);
  assert.deepStrictEqual(destrabada.borrar, ['MLU9'], 'si se arregla, se olvida');
  tabla = [];
  assert.strictEqual(correr(falla).avisar.length, 0, 'si vuelve a fallar, el conteo arranca de cero');
});

test('stock: sin la migración no avisa nada (mejor callado que cada hora)', async () => {
  const s = fakeSupabase({}, { faltan: ['stock_sync_fallos'] });
  const falla = [{ sku: 'S1', meli_id: 'MLU9', error: 'x' }];
  for (let i = 0; i < 4; i++) assert.deepStrictEqual(await registrarFallos(s, falla), []);
});

test('stock: registrarFallos guarda el conteo entre corridas', async () => {
  const s = fakeSupabase({});
  const falla = [{ sku: 'S1', meli_id: 'MLU9', error: 'x' }, { sku: 'S2', meli_id: 'MLU8', error: 'y' }];
  await registrarFallos(s, falla);
  await registrarFallos(s, falla.slice(0, 1));
  assert.deepStrictEqual(s._tablas.stock_sync_fallos.map(f => [f.meli_id, f.veces]), [['MLU9', 2]]);
  const avisar = await registrarFallos(s, falla.slice(0, 1));
  assert.deepStrictEqual(avisar.map(f => f.meli_id), ['MLU9']);
});

// ── Resumen diario ─────────────────────────────────────────────────────────

test('resumen: usa el día de Montevideo, no el de UTC', () => {
  assert.strictEqual(hoyEnUruguay(new Date('2026-11-14T01:30:00Z')), '2026-11-13');
  assert.strictEqual(hoyEnUruguay(new Date('2026-11-13T23:00:00Z')), '2026-11-13');
});

test('resumen: sin canceladas y con Shopify', () => {
  const msg = armarResumen({
    fecha: '2026-11-13',
    ventas: [
      { sku: 'E', canal: 'meli', estado: 'pagada', producto: 'Espejo', cantidad: 2, total: 2000, comision: 300 },
      { sku: 'P', canal: 'shopify', estado: 'pagada', producto: 'Puños <Domino>', cantidad: 1, total: 450, comision: 0 },
      { sku: 'C', canal: 'mostrador', estado: 'cancelada', producto: 'Casco', cantidad: 1, total: 9000, comision: 0 },
    ],
    envios: [{ estado: 'pendiente' }, { estado: 'en_camino' }],
    productos: [],
  });
  assert.match(msg, /Ingresos:<\/b> \$2\.450/);
  assert.match(msg, /Ventas:<\/b> 2 \(🟡 MELI: 1 \| 🛍️ Shopify: 1\)/);
  assert.doesNotMatch(msg, /Mostrador/, 'la cancelada no cuenta');
  assert.match(msg, /sin despachar: 1 \| en camino: 1/);
});

test('resumen: stock sólo de lo que se vendió — sin stock y menos de 45 días de cobertura', () => {
  const prod = (sku, nombre, stock_dep, extra = {}) => ({ sku, nombre, stock_dep, unidades_por_venta: 1, discontinuado: false, ...extra });
  const venta = (sku, cantidad, extra = {}) => ({ sku, canal: 'meli', estado: 'pagada', producto: sku, cantidad, total: 100, comision: 0, ...extra });
  const ventasDia = [venta('ROJO', 1), venta('ESPEJO', 2), venta('SOPORTE', 1), venta('VIEJO', 1), venta('SLIDER', 1), venta('CANCEL', 1, { estado: 'cancelada' })];
  const ventasRitmo = [
    ...ventasDia,
    venta('ESPEJO', 31),          // 33 en 30 días: 1,1 por día → 10 alcanzan para ~9 días
    venta('SOPORTE', 2),          // 3 en 30 días: 0,1 por día → 82 alcanzan para 820 días
    venta('SLIDER', 5),           // 6 pares en 30 días: 0,2 por día → 5 pares para 25 días
  ];
  const productos = [
    prod('ROJO', 'Manillar 22mm - Rojo', 0),
    prod('ESPEJO', 'Espejos Alerón Grande', 10),
    prod('SOPORTE', 'Soporte Celular', 82),
    prod('VIEJO', 'Escape descatalogado', 0, { discontinuado: true }),
    prod('SLIDER', 'Slider (par)', 11, { unidades_por_venta: 2 }),
    prod('CANCEL', 'Casco', 0),
    prod('NOVENDIO', 'Gato elevador', 0),
  ];
  const r = stockDeLoVendido({ ventasDia, ventasRitmo, productos, llegadas: { ROJO: '2026-12-12' } });
  assert.deepStrictEqual(r.quiebres.map(f => f.sku), ['ROJO']);
  assert.deepStrictEqual(r.cortos.map(f => [f.sku, Math.round(f.dias)]), [['ESPEJO', 9], ['SLIDER', 25]]);

  const msg = armarResumen({ fecha: '2026-11-15', ventas: ventasDia, ventasRitmo, envios: [], productos, llegadas: { ROJO: '2026-12-12' } });
  assert.match(msg, /Stock de lo que se vendió/);
  assert.match(msg, /🔴 Manillar 22mm - Rojo: <b>se quedó sin stock<\/b> \(vendió 1\) · llega ~12\/12/);
  assert.match(msg, /🟡 Espejos Alerón Grande: quedan 10, para ~9 días \(vende 1,1 por día\)/);
  assert.match(msg, /🟡 Slider \(par\): quedan 5, para ~25 días/);
  assert.doesNotMatch(msg, /Soporte Celular|Escape descatalogado|Gato elevador|Casco/);
  assert.doesNotMatch(msg, /Stock bajo/, 'ya no manda la lista general de stock bajo');
});

test('resumen: si todo lo vendido tiene stock de sobra, lo dice en una línea; sin ventas, no habla de stock', () => {
  const productos = [{ sku: 'S', nombre: 'Soporte', stock_dep: 80, unidades_por_venta: 1, discontinuado: false }];
  const ventas = [{ sku: 'S', canal: 'meli', estado: 'pagada', producto: 'Soporte', cantidad: 1, total: 490, comision: 0 }];
  assert.match(armarResumen({ fecha: '2026-11-15', ventas, ventasRitmo: ventas, envios: [], productos }),
    /✅ <b>Stock:<\/b> lo que se vendió tiene para más de 45 días/);
  assert.doesNotMatch(armarResumen({ fecha: '2026-11-15', ventas: [], envios: [], productos }), /Stock/);
});

test('resumen: a las 10:00 de Montevideo resume el día anterior completo', () => {
  // 16/11 13:00 UTC = 10:00 en Montevideo → el día que se resume es el 15/11.
  assert.strictEqual(diaAnterior(hoyEnUruguay(new Date('2026-11-16T13:00:00Z'))), '2026-11-15');
  // Cambio de mes y de año.
  assert.strictEqual(diaAnterior('2026-12-01'), '2026-11-30');
  assert.strictEqual(diaAnterior('2027-01-01'), '2026-12-31');

  const msg = armarResumen({ fecha: '2026-11-15', ventas: [], envios: [], productos: [] });
  assert.match(msg, /Resumen de ayer — domingo 15\/11/);
  assert.match(msg, /Sin ventas\./);
  assert.match(msg, /Envíos activos ahora:<\/b> 0/);
});
