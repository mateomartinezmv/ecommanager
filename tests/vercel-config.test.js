// vercel.json, antes de que lo rechace el deploy: Vercel valida el esquema y corta el build
// entero si algo no pasa (le pasó al PR del tracking por una entrada 51 en `functions`).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(RAIZ, 'vercel.json'), 'utf8'));

function archivos(dir) {
  return fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? archivos(path.join(dir, e.name)) : [path.join(dir, e.name).split(path.sep).join('/')]);
}
const API = archivos('api');

// Glob de Vercel a regex: `**` cruza carpetas, `*` no.
function aRegex(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + re + '$');
}

test('`functions` tiene como mucho 50 entradas (el máximo que acepta Vercel)', () => {
  const n = Object.keys(config.functions).length;
  assert.ok(n <= 50, `vercel.json tiene ${n} entradas en functions: juntá algunas con un glob`);
});

test('cada entrada de `functions` apunta a una función que existe', () => {
  for (const glob of Object.keys(config.functions)) {
    assert.ok(API.some(f => aRegex(glob).test(f)), `${glob} no coincide con ningún archivo de api/ y Vercel corta el deploy`);
  }
  assert.ok(aRegex('api/t*.js').test('api/tracking.js'), 'el tracking tiene sus 30 segundos');
});

test('cada cron llama a un endpoint que existe', () => {
  for (const { path: ruta } of config.crons) {
    const archivo = 'api/' + ruta.split('?')[0].replace(/^\/api\//, '') + '.js';
    assert.ok(API.includes(archivo), `el cron ${ruta} no tiene ${archivo}`);
  }
});
