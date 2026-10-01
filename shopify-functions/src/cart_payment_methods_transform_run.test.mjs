import { cartPaymentMethodsTransformRun as run } from './cart_payment_methods_transform_run.js';

// Los medios de pago reales de Martinez Motos, tal como figuran en el checkout.
const METODOS = [
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/1', name: 'Tarjeta de crédito' },
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/2', name: 'Transferencia Bancaria' },
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/3', name: 'Efectivo (solo retiros en el local)' },
];

const entrada = (valor, metodos = METODOS) => ({
  cart: { attribute: valor === null ? null : { value: valor } },
  paymentMethods: metodos,
});
const ocultados = (res, metodos = METODOS) =>
  res.operations
    .map((o) => metodos.find((m) => m.id === o.paymentMethodHide.paymentMethodId).name)
    .sort();

let fallos = 0;
const chk = (ok, msg) => { if (!ok) fallos++; console.log((ok ? 'OK  ' : 'MAL ') + msg); };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('--- los dos sentidos ---');
let r = run(entrada('Transferencia o efectivo'));
chk(igual(ocultados(r), ['Tarjeta de crédito']),
    'contado -> oculta la tarjeta: ' + JSON.stringify(ocultados(r)));

r = run(entrada('Tarjeta o cuotas'));
chk(igual(ocultados(r), ['Efectivo (solo retiros en el local)', 'Transferencia Bancaria']),
    'tarjeta -> oculta transferencia y efectivo: ' + JSON.stringify(ocultados(r)));

console.log('\n--- sin eleccion: "Comprar ahora" saltea el carrito ---');
for (const [nombre, val] of [['sin atributo', null], ['atributo vacio', ''], ['valor desconocido', 'Pagar despues']]) {
  r = run(entrada(val));
  chk(r.operations.length === 0, nombre + ' -> no oculta nada (el cliente nunca eligio)');
}

console.log('\n--- wallets nuevos caen del lado tarjeta solos ---');
const conWallet = METODOS.concat([
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/4', name: 'Mercado Pago' },
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/5', name: 'Apple Pay' },
]);
r = run(entrada('Transferencia o efectivo', conWallet));
chk(igual(ocultados(r, conWallet), ['Apple Pay', 'Mercado Pago', 'Tarjeta de crédito']),
    'contado -> tambien los oculta: ' + JSON.stringify(ocultados(r, conWallet)));
r = run(entrada('Tarjeta o cuotas', conWallet));
chk(igual(ocultados(r, conWallet), ['Efectivo (solo retiros en el local)', 'Transferencia Bancaria']),
    'tarjeta -> los deja disponibles: ' + JSON.stringify(ocultados(r, conWallet)));

console.log('\n--- fail-open: nunca dejar el checkout sin medios de pago ---');
const soloTarjeta = [METODOS[0]];
chk(run(entrada('Transferencia o efectivo', soloTarjeta)).operations.length === 0,
    'contado pero solo hay tarjeta -> no oculta nada');
const soloContado = [METODOS[1], METODOS[2]];
chk(run(entrada('Tarjeta o cuotas', soloContado)).operations.length === 0,
    'tarjeta pero solo hay transferencia/efectivo -> no oculta nada');
const renombrados = [{ id: 'x', name: 'Deposito bancario' }, { id: 'y', name: 'Tarjeta' }];
chk(run(entrada('Transferencia o efectivo', renombrados)).operations.length === 0,
    'ningun medio reconocido como contado -> no oculta nada');
chk(run(entrada('Transferencia o efectivo', [])).operations.length === 0,
    'sin metodos en el input -> no oculta nada');

console.log('\n--- varios ---');
chk(run(entrada('TRANSFERENCIA O EFECTIVO')).operations.length === 1, 'no depende de mayusculas');
chk(run(entrada('Tarjeta, debito o cuotas')).operations.length === 2, 'tolera variantes del texto de tarjeta');

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
