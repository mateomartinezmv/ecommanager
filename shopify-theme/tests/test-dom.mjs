import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';

const JS = readFileSync('pc.js', 'utf8');

const caja = (quiere, aplicado, nota) => `
  <div class="pago-contado" data-pago-contado data-codigo="CONTADO10" data-attr="Forma de pago"
       data-val-contado="Transferencia o efectivo" data-val-tarjeta="Tarjeta o cuotas"
       data-quiere="${quiere}" data-aplicado="${aplicado}" data-grupo="pago-contado-drawer">
    <input type="radio" name="pago-contado-drawer" value="contado"${quiere === 'contado' ? ' checked' : ''}>
    <input type="radio" name="pago-contado-drawer" value="tarjeta"${quiere === 'contado' ? '' : ' checked'}>
    <p data-pago-contado-estado>${nota}</p>
  </div>`;

const pagina = (quiere, aplicado, nota, total) => `<!doctype html><html><body>
  <cart-drawer><div id="CartDrawer"><div class="drawer__inner"><div class="drawer__footer">
    ${caja(quiere, aplicado, nota)}
    <div class="cart-drawer__footer"><p class="total">${total}</p></div>
  </div></div></div></cart-drawer>
</body></html>`;

function montar(html, respuesta) {
  const vc = new VirtualConsole();
  const errores = [];
  vc.on('jsdomError', (e) => errores.push(e.message));
  const dom = new JSDOM(html, { url: 'https://martinezmotos.com/', virtualConsole: vc, runScripts: 'outside-only' });
  const w = dom.window;
  const pedidos = [];
  w.fetch = (url, opts) => {
    pedidos.push({ url, body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(respuesta) });
  };
  w.eval(JS);
  return { dom, w, d: w.document, pedidos, errores };
}

const esperar = () => new Promise((r) => setTimeout(r, 20));
let fallos = 0;
const chk = (ok, msg) => { if (!ok) fallos++; console.log((ok ? 'OK  ' : 'MAL ') + msg); };

// ---------------------------------------------------------------
console.log('--- tocar "Transferencia o efectivo" en el drawer ---');
{
  const frescoHTML = pagina('contado', 'true', 'Descuento aplicado. Al finalizar la compra, pagá con transferencia o efectivo.', '$2.061,00');
  const { w, d, pedidos, errores } = montar(
    pagina('tarjeta', 'false', 'Elegí transferencia o efectivo y el total baja 10%.', '$2.290,00'),
    { sections: { 'cart-drawer': frescoHTML } }
  );
  const drawerAntes = d.querySelector('cart-drawer');
  d.querySelector('input[value="contado"]').click();
  await esperar();

  chk(pedidos.length === 1, 'hizo exactamente 1 request');
  const b = pedidos[0].body;
  chk(b.attributes['Forma de pago'] === 'Transferencia o efectivo', 'manda el atributo correcto');
  chk(b.discount === 'CONTADO10', 'manda el codigo de descuento');
  chk(b.sections === 'cart-drawer', 'pide la seccion del drawer: ' + b.sections);
  chk(d.querySelector('.cart-drawer__footer .total').textContent === '$2.061,00',
      'el total se actualizo en el lugar -> ' + d.querySelector('.cart-drawer__footer .total').textContent);
  chk(d.querySelector('[data-pago-contado]').getAttribute('data-aplicado') === 'true',
      'el selector refleja el descuento aplicado');
  chk(d.querySelector('[data-pago-contado-estado]').textContent.startsWith('Descuento aplicado'),
      'la nota cambio');
  chk(d.querySelector('cart-drawer') === drawerAntes,
      'NO se reemplazo <cart-drawer>: el drawer sigue abierto');
  chk(!errores.some((e) => /navigation|Not implemented/i.test(e)), 'NO recargo la pagina');
}

// ---------------------------------------------------------------
console.log('\n--- volver a "Tarjeta" ---');
{
  const frescoHTML = pagina('tarjeta', 'false', 'Elegí transferencia o efectivo y el total baja 10%.', '$2.290,00');
  const { d, pedidos } = montar(
    pagina('contado', 'true', 'Descuento aplicado.', '$2.061,00'),
    { sections: { 'cart-drawer': frescoHTML } }
  );
  d.querySelector('input[value="tarjeta"]').click();
  await esperar();
  chk(pedidos[0].body.discount === '', 'manda discount vacio para quitarlo');
  chk(d.querySelector('.cart-drawer__footer .total').textContent === '$2.290,00',
      'el total volvio a $2.290,00');
}

// ---------------------------------------------------------------
console.log('\n--- fallback: si la seccion no viene, recarga ---');
{
  const { d, errores } = montar(
    pagina('tarjeta', 'false', 'Elegí transferencia o efectivo.', '$2.290,00'),
    { sections: {} }
  );
  d.querySelector('input[value="contado"]').click();
  await esperar();
  chk(errores.some((e) => /navigation|Not implemented/i.test(e)),
      'sin secciones -> cae al reload (red de seguridad)');
}

// ---------------------------------------------------------------
console.log('\n--- el drawer se re-renderiza: el listener tiene que sobrevivir ---');
{
  const frescoHTML = pagina('contado', 'true', 'Descuento aplicado.', '$2.061,00');
  const { d, pedidos } = montar(
    pagina('tarjeta', 'false', 'Elegí transferencia o efectivo.', '$2.290,00'),
    { sections: { 'cart-drawer': frescoHTML } }
  );
  // Shrine reemplaza el interior del drawer con innerHTML (los <script> no corren)
  d.querySelector('.drawer__footer').innerHTML =
    caja('tarjeta', 'false', 'Elegí transferencia o efectivo.') +
    '<div class="cart-drawer__footer"><p class="total">$2.290,00</p></div>';

  d.querySelector('input[value="contado"]').click();
  await esperar();
  chk(pedidos.length === 1, 'ESTE ERA EL BUG: despues del re-render sigue respondiendo');
  chk(d.querySelector('.cart-drawer__footer .total').textContent === '$2.061,00', 'y actualiza el total');
}

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
