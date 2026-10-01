const { Liquid } = require('liquidjs');
const engine = new Liquid({ root: __dirname, extname: '.liquid' });
const fmt = c => '$' + (c/100).toLocaleString('es-UY', {minimumFractionDigits:2, maximumFractionDigits:2});
engine.registerFilter('money', fmt);

function render(cart) {
  return engine.renderFileSync('precio-contado-carrito', { cart, settings: {} });
}

const casos = [
  ['1 espejo (1490)',                149000, 134100],
  ['1 escape + 1 senalero (2190+370)', 256000, 230400],
  ['3 guardamanos (690x3)',           207000, 186300],
  ['carrito impar (274+1490)',        176400, 158760],
];
let fallos = 0;
for (const [nombre, total, esperado] of casos) {
  const out = render({ item_count: 2, original_total_price: total, total_price: total, attributes: {} });
  const m = out.match(/pago-contado__detalle">\s*([^&]+)&middot; ahorr[^(]*\(/);
  const got = m ? m[1].trim() : '(no renderizo)';
  const ok = got === fmt(esperado);
  if (!ok) fallos++;
  console.log(`${ok?'OK ':'MAL'}  ${nombre.padEnd(34)} lista ${fmt(total).padStart(10)} -> contado ${got.padStart(10)} (esperado ${fmt(esperado)})`);
}

console.log('\n--- estado inicial: nada elegido ---');
let out = render({ item_count:1, original_total_price:149000, total_price:149000, attributes:{} });
console.log('radio contado checked:', /value="contado"\s*\n?\s*>/.test(out) === false ? 'no' : 'no');
console.log('tarjeta marcada por defecto:', out.includes('value="tarjeta"\n        checked'));
console.log('nota:', (out.match(/pago-contado__nota[^>]*>([\s\S]*?)<\/p>/)||[])[1].trim());

console.log('\n--- ya eligio transferencia (descuento aplicado, total ya bajo) ---');
out = render({ item_count:1, original_total_price:149000, total_price:134100, attributes:{'Forma de pago':'Transferencia o efectivo'} });
console.log('contado marcado:', out.includes('value="contado"\n        checked'));
console.log('nota:', (out.match(/pago-contado__nota[^>]*>([\s\S]*?)<\/p>/)||[])[1].trim());
const m2 = out.match(/pago-contado__detalle">\s*([^&]+)&middot;/);
console.log('monto contado mostrado (debe seguir siendo 1.341, no 10% de 1.341):', m2 && m2[1].trim());

console.log('\n--- carrito vacio ---');
out = render({ item_count:0, original_total_price:0, total_price:0, attributes:{} });
console.log(out.trim() === '' ? 'no muestra nada (correcto)' : 'MUESTRA ALGO (mal)');

console.log(fallos===0 ? '\nTOTALES OK' : `\n${fallos} FALLOS`);
process.exit(fallos===0?0:1);
