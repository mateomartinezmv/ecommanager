const { Liquid } = require('liquidjs');
const engine = new Liquid({ root: __dirname, extname: '.liquid' });

const fmt = c => '$' + (c/100).toLocaleString('es-UY', {minimumFractionDigits:2, maximumFractionDigits:2});
engine.registerFilter('money', fmt);
engine.registerFilter('money_with_currency', c => fmt(c) + ' UYU');
engine.registerFilter('asset_url', f => '/assets/' + f);
engine.registerFilter('stylesheet_tag', u => `<link rel="stylesheet" href="${u}">`);

// Productos reales de Martinez Motos (precios en centavos, como los pasa Shopify)
const casos = [
  ['Espejos aleron finos',      149000, 134000],
  ['Escape SC Project plateado',219000, 197000],
  ['Senaleros LED finos',        37000,  33000],
  ['Guardabarros / Sliders',    129000, 116000],
  ['Guardamanos enduro',         69000,  62000],
  ['Escape Akrapovic',          399000, 359000],
  ['Extensor pata lateral',      27400,  24660],  // guard: redondeo >1% -> precio exacto
  ['Punos metalicos',           167000, 150000],
];

let fallos = 0;
for (const [nombre, precio, esperado] of casos) {
  const product = {
    available: true,
    price_varies: false,
    price_min: precio,
    selected_or_first_available_variant: { price: precio },
    metafields: { custom: {} },
  };
  const out = engine.renderFileSync('precio-contado', { product, destacado: true, settings: {} });
  const m = out.match(/precio-contado__monto">([^<]+)</);
  const got = m ? m[1].trim() : '(no renderizo)';
  const want = fmt(esperado);
  const ok = got === want;
  if (!ok) fallos++;
  console.log(`${ok ? 'OK ' : 'MAL'}  ${nombre.padEnd(28)} lista ${fmt(precio).padStart(10)}  ->  contado ${got.padStart(10)}  (esperado ${want})`);
}

// Casos borde
const borde = (nombre, ctx) => {
  const out = engine.renderFileSync('precio-contado', Object.assign({ settings: {} }, ctx));
  const vacio = out.trim() === '';
  console.log(`${nombre.padEnd(42)} -> ${vacio ? 'no muestra nada (correcto)' : 'MUESTRA: ' + out.trim().replace(/\s+/g,' ').slice(0,90)}`);
};
console.log('\n--- casos borde ---');
borde('producto agotado (available:false)', { product: { available:false, selected_or_first_available_variant:{price:149000}, metafields:{custom:{}} }, destacado:true });
borde('metafield sin_precio_contado = true', { product: { available:true, selected_or_first_available_variant:{price:149000}, metafields:{custom:{sin_precio_contado:{value:true}}} }, destacado:true });
borde('sin product ni variant', { destacado:true });

console.log('\n--- grilla (compacto, precio variable 2190-2490) ---');
console.log(engine.renderFileSync('precio-contado', {
  product: { available:true, price_varies:true, price_min:219000, selected_or_first_available_variant:{price:219000}, metafields:{custom:{}} },
  compacto: true, settings: {},
}).trim().replace(/\s+/g,' '));

console.log('\n--- override del porcentaje a 15% sobre 1490 ---');
console.log(engine.renderFileSync('precio-contado', {
  product: { available:true, selected_or_first_available_variant:{price:149000}, metafields:{custom:{}} },
  pct_override: 15, destacado: true, settings: {},
}).trim().replace(/\s+/g,' '));

console.log(fallos === 0 ? '\nTODOS LOS PRECIOS OK' : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
