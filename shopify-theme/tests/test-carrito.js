const { Liquid } = require('liquidjs');
const engine = new Liquid({ root: __dirname, extname: '.liquid' });
const fmt = c => '$' + (c/100).toLocaleString('es-UY', {minimumFractionDigits:2, maximumFractionDigits:2});
engine.registerFilter('money', fmt);

const render = cart => engine.renderFileSync('precio-contado-carrito', { cart, settings: {} });
const nota = out => (out.match(/pago-contado__nota[^>]*>([\s\S]*?)<\/p>/)||[])[1].trim();
const attr = (out,k) => (out.match(new RegExp(k+'="([^"]*)"'))||[])[1];

let fallos = 0;
const chk = (ok, msg) => { if(!ok) fallos++; console.log((ok?'OK  ':'MAL ')+msg); };

console.log('--- montos (producto de la captura: $1.690) ---');
let out = render({ item_count:1, original_total_price:169000, total_price:169000, attributes:{} });
const m = out.match(/pago-contado__detalle">\s*([^&]+)&middot; ahorrás ([^ ]+) /);
chk(m && m[1].trim()==='$1.521,00', 'contado $1.521,00  -> '+(m&&m[1].trim()));
chk(m && m[2].trim()==='$169,00',   'ahorro  $169,00    -> '+(m&&m[2].trim()));

console.log('\n--- el caso que fallo: atributo puesto pero descuento NO aplicado ---');
out = render({ item_count:1, original_total_price:169000, total_price:169000,
               attributes:{'Forma de pago':'Transferencia o efectivo'} });
chk(attr(out,'data-quiere')==='contado',  'data-quiere = contado');
chk(attr(out,'data-aplicado')==='false',  'data-aplicado = false  (antes mentia "aplicado")');
chk(nota(out)==='Aplicando el descuento...', 'nota honesta -> "'+nota(out)+'"');

console.log('\n--- descuento realmente aplicado ---');
out = render({ item_count:1, original_total_price:169000, total_price:152100,
               attributes:{'Forma de pago':'Transferencia o efectivo'} });
chk(attr(out,'data-aplicado')==='true', 'data-aplicado = true');
chk(nota(out).startsWith('Descuento aplicado'), 'nota -> "'+nota(out)+'"');
const m2 = out.match(/pago-contado__detalle">\s*([^&]+)&middot;/);
chk(m2 && m2[1].trim()==='$1.521,00', 'el monto NO se recalcula sobre el ya rebajado -> '+(m2&&m2[1].trim()));

console.log('\n--- eligio tarjeta ---');
out = render({ item_count:1, original_total_price:169000, total_price:169000,
               attributes:{'Forma de pago':'Tarjeta o cuotas'} });
chk(attr(out,'data-quiere')==='tarjeta', 'data-quiere = tarjeta');
chk(nota(out).startsWith('Elegí transferencia'), 'nota -> "'+nota(out)+'"');

console.log('\n--- carrito vacio ---');
chk(render({ item_count:0, original_total_price:0, total_price:0, attributes:{} }).trim()==='', 'no renderiza nada');

console.log(fallos===0 ? '\nTODO OK' : `\n${fallos} FALLOS`);
process.exit(fallos===0?0:1);
