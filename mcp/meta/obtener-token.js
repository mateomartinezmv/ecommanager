#!/usr/bin/env node
// mcp/meta/obtener-token.js
// Convierte el token corto que da el Explorador de Graph API (dura ~1 hora) en un token de
// página que no vence, y muestra los ids de la página y de su Instagram.
//
// Uso:
//   META_APP_ID=... META_APP_SECRET=... node mcp/meta/obtener-token.js <token-corto> [--guardar] [--pagina <id>]
//
// Con --guardar escribe mcp/meta/.env (está en .gitignore). Si tenés varias páginas, elegí
// cuál con --pagina.

const fs = require('node:fs');
const path = require('node:path');
const { GRAPH_VERSION_DEFAULT, explicarErrorGraph } = require('./_meta');

const ARCHIVO_ENV = path.join(__dirname, '.env');
if (fs.existsSync(ARCHIVO_ENV)) process.loadEnvFile(ARCHIVO_ENV);

const version = process.env.META_GRAPH_VERSION || GRAPH_VERSION_DEFAULT;
const base = `https://graph.facebook.com/${version}`;

async function get(ruta, params) {
  const url = new URL(`${base}/${ruta}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw new Error(explicarErrorGraph(data?.error, res.status));
  return data;
}

async function main() {
  let corto = null;
  let guardar = false;
  let elegida = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--guardar') guardar = true;
    else if (args[i] === '--pagina') elegida = args[++i];
    else corto = args[i];
  }
  const appId = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;

  if (!corto || !appId || !secret) {
    console.error('Uso: META_APP_ID=... META_APP_SECRET=... node mcp/meta/obtener-token.js <token-corto> [--guardar] [--pagina <id>]');
    process.exit(1);
  }

  const largo = await get('oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: secret,
    fb_exchange_token: corto,
  });

  // Si lo que se pegó ya es un token de página (en el Explorador se eligió la página en vez de
  // "Token de usuario"), no hay /me/accounts. El canje igual devuelve un token de página, pero
  // dura 60 días en vez de no vencer.
  const debug = await get('debug_token', { input_token: largo.access_token, access_token: largo.access_token });
  let lista;
  if (debug.data?.type === 'PAGE') {
    const p = await get('me', {
      fields: 'id,name,instagram_business_account{id,username}',
      access_token: largo.access_token,
    });
    lista = [{ ...p, access_token: largo.access_token }];
    const vence = debug.data.expires_at ? new Date(debug.data.expires_at * 1000).toLocaleDateString('es-UY') : null;
    console.log(`Ojo: pegaste un token de página, así que el nuevo vence${vence ? ` el ${vence}` : ''}. Para uno que `
      + 'no venza, en el Explorador dejá elegido "Token de usuario" (no la página) y volvé a correr esto.\n');
  } else {
    // El token de página que sale de un token de usuario largo no vence.
    const paginas = await get('me/accounts', {
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      access_token: largo.access_token,
    });
    lista = paginas.data || [];
  }
  if (!lista.length) {
    throw new Error('El usuario no administra ninguna página, o al token le falta pages_show_list.');
  }

  console.log('Páginas encontradas:');
  for (const p of lista) {
    const ig = p.instagram_business_account;
    console.log(`  - ${p.name} (id ${p.id})${ig ? ` → Instagram @${ig.username} (id ${ig.id})` : ' → sin Instagram vinculado'}`);
  }

  const pagina = elegida ? lista.find(p => p.id === elegida) : (lista.length === 1 ? lista[0] : null);
  if (!pagina) {
    console.log('\nTenés varias páginas: volvé a correrlo con --pagina <id>.');
    return;
  }

  const lineas = [
    `META_PAGE_ID=${pagina.id}`,
    `META_PAGE_ACCESS_TOKEN=${pagina.access_token}`,
    pagina.instagram_business_account ? `META_IG_USER_ID=${pagina.instagram_business_account.id}` : null,
  ].filter(Boolean);

  if (guardar) {
    const previas = fs.existsSync(ARCHIVO_ENV)
      ? fs.readFileSync(ARCHIVO_ENV, 'utf8').split('\n')
        .filter(l => l.trim() && !/^META_(PAGE_ID|PAGE_ACCESS_TOKEN|IG_USER_ID)=/.test(l))
      : [];
    fs.writeFileSync(ARCHIVO_ENV, [...previas, ...lineas].join('\n') + '\n', { mode: 0o600 });
    console.log(`\nGuardado en ${ARCHIVO_ENV}. Reiniciá Claude Code para que lo tome.`);
  } else {
    console.log('\nAgregá esto a tu entorno (o corré con --guardar):\n');
    console.log(lineas.join('\n'));
  }
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
