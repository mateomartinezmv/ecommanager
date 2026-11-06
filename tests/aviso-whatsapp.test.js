// Avisos por WhatsApp (Kapso) con Telegram de respaldo.
const test = require('node:test');
const assert = require('node:assert');
const { enviarAviso, htmlAWhatsapp } = require('../api/_aviso');

const ENV = ['KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID', 'WHATSAPP_TO', 'KAPSO_TEMPLATE_NAME',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

function conEntorno(vars, respuestas, fn) {
  return async () => {
    const antes = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
    const fetchAntes = global.fetch;
    ENV.forEach(k => delete process.env[k]);
    Object.assign(process.env, vars);
    const llamadas = [];
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      llamadas.push({ url, body, headers: opts.headers });
      const ok = respuestas.shift() ?? true;
      return { ok, status: ok ? 200 : 400, text: async () => '{}', json: async () => ({}) };
    };
    try { await fn(llamadas); } finally {
      global.fetch = fetchAntes;
      ENV.forEach(k => { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; });
    }
  };
}

const KAPSO = { KAPSO_API_KEY: 'k', KAPSO_PHONE_NUMBER_ID: '111', WHATSAPP_TO: '59899000000' };
const TG = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '5' };

test('convierte el HTML de Telegram al formato de WhatsApp', () => {
  assert.strictEqual(htmlAWhatsapp('<b>Hola</b> A &amp; B &lt;x&gt;'), '*Hola* A & B <x>');
});

test('con Kapso configurado manda texto por WhatsApp y no toca Telegram', conEntorno({ ...KAPSO, ...TG }, [true], async (ll) => {
  assert.strictEqual(await enviarAviso('<b>Venta</b>'), true);
  assert.strictEqual(ll.length, 1);
  assert.match(ll[0].url, /api\.kapso\.ai\/meta\/whatsapp\/v24\.0\/111\/messages$/);
  assert.strictEqual(ll[0].headers['X-API-Key'], 'k');
  assert.deepStrictEqual(ll[0].body, { messaging_product: 'whatsapp', to: '59899000000', type: 'text', text: { body: '*Venta*' } });
}));

test('si el texto falla (ventana de 24 h cerrada) usa la plantilla, aplanada', conEntorno({ ...KAPSO, KAPSO_TEMPLATE_NAME: 'aviso_ecommanager' }, [false, true], async (ll) => {
  assert.strictEqual(await enviarAviso('<b>Pausada</b>\n\nMotivo: sin stock'), true);
  assert.strictEqual(ll[1].body.type, 'template');
  assert.strictEqual(ll[1].body.template.name, 'aviso_ecommanager');
  assert.strictEqual(ll[1].body.template.components[0].parameters[0].text, '*Pausada* · Motivo: sin stock');
}));

test('si WhatsApp falla del todo, cae a Telegram', conEntorno({ ...KAPSO, ...TG }, [false, true], async (ll) => {
  assert.strictEqual(await enviarAviso('<b>x</b>'), true);
  assert.match(ll[1].url, /api\.telegram\.org\/bott\/sendMessage/);
  assert.strictEqual(ll[1].body.text, '<b>x</b>');
}));

test('sin Kapso configurado sigue mandando por Telegram como antes', conEntorno(TG, [true], async (ll) => {
  assert.strictEqual(await enviarAviso('hola'), true);
  assert.strictEqual(ll.length, 1);
  assert.match(ll[0].url, /api\.telegram\.org/);
}));
