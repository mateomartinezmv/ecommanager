import { cartPaymentMethodsTransformRun as run } from './cart_payment_methods_transform_run.js';

const METODOS = [
  { id: '1', name: 'Tarjeta de crédito' },
  { id: '2', name: 'Transferencia Bancaria' },
  { id: '3', name: 'Efectivo (solo retiros en el local)' },
];
const DESC_PRODUCTO = [{ targetType: 'LINE_ITEM', allocationMethod: 'ACROSS' }];
const DESC_ENVIO    = [{ targetType: 'SHIPPING_LINE', allocationMethod: 'EACH' }];

const entrada = (attr, descuentos = [], metodos = METODOS) => ({
  cart: { attribute: attr === null ? null : { value: attr }, discountApplications: descuentos },
  paymentMethods: metodos,
});
const ocultados = (res, metodos = METODOS) =>
  res.operations.map((o) => metodos.find((m) => m.id === o.paymentMethodHide.paymentMethodId).name).sort();

let fallos = 0;
const chk = (ok, msg) => { if (!ok) fallos++; console.log((ok ? 'OK  ' : 'MAL ') + msg); };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TARJETA = ['Tarjeta de crédito'];
const CONTADO = ['Efectivo (solo retiros en el local)', 'Transferencia Bancaria'];

console.log('--- el descuento manda ---');
let r = run(entrada('Transferencia o efectivo', DESC_PRODUCTO));
chk(igual(ocultados(r), TARJETA), 'con descuento -> oculta la tarjeta');

r = run(entrada('Transferencia o efectivo', []));
chk(igual(ocultados(r), CONTADO),
    'EL CASO NUEVO: eligio contado pero saco el descuento en el checkout -> vuelve la tarjeta');

r = run(entrada('Tarjeta o cuotas', []));
chk(igual(ocultados(r), CONTADO), 'eligio tarjeta -> oculta transferencia y efectivo');

r = run(entrada('Tarjeta o cuotas', DESC_PRODUCTO));
chk(igual(ocultados(r), TARJETA), 'eligio tarjeta pero tipeo el codigo a mano -> manda el descuento');

console.log('\n--- envio gratis no cuenta como descuento ---');
r = run(entrada(null, DESC_ENVIO));
chk(r.operations.length === 0, 'solo descuento de envio y sin eleccion -> no oculta nada');
r = run(entrada('Transferencia o efectivo', DESC_ENVIO));
chk(igual(ocultados(r), CONTADO), 'solo descuento de envio -> no lo confunde con CONTADO10');
r = run(entrada(null, DESC_ENVIO.concat(DESC_PRODUCTO)));
chk(igual(ocultados(r), TARJETA), 'envio + producto -> detecta el de producto');

console.log('\n--- sin eleccion: "Comprar ahora" saltea el carrito ---');
for (const [nombre, val] of [['sin atributo', null], ['atributo vacio', '']]) {
  chk(run(entrada(val, [])).operations.length === 0, nombre + ' y sin descuento -> no oculta nada');
}

console.log('\n--- fail-open ---');
chk(run(entrada('Transferencia o efectivo', DESC_PRODUCTO, [METODOS[0]])).operations.length === 0,
    'con descuento pero solo hay tarjeta -> no oculta nada');
chk(run(entrada('Tarjeta o cuotas', [], [METODOS[1], METODOS[2]])).operations.length === 0,
    'sin descuento pero solo hay contado -> no oculta nada');
chk(run(entrada('Transferencia o efectivo', DESC_PRODUCTO, [])).operations.length === 0,
    'sin metodos -> no oculta nada');

console.log('\n--- wallets nuevos ---');
const conWallet = METODOS.concat([{ id: '4', name: 'Mercado Pago' }, { id: '5', name: 'Apple Pay' }]);
r = run(entrada(null, DESC_PRODUCTO, conWallet));
chk(igual(ocultados(r, conWallet), ['Apple Pay', 'Mercado Pago', 'Tarjeta de crédito']),
    'con descuento -> los oculta sin tocar la funcion');

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
