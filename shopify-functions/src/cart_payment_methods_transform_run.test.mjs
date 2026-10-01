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

let r = run(entrada('Transferencia o efectivo'));
chk(igual(ocultados(r), ['Tarjeta de crédito']), 'contado -> oculta solo la tarjeta: ' + JSON.stringify(ocultados(r)));

r = run(entrada('Tarjeta o cuotas'));
chk(r.operations.length === 0, 'eligio tarjeta -> no oculta nada');

r = run(entrada(null));
chk(r.operations.length === 0, 'sin atributo -> no oculta nada');

r = run(entrada(''));
chk(r.operations.length === 0, 'atributo vacio -> no oculta nada');

// Wallet nuevo que nadie agrego a ninguna lista: la lista blanca lo tapa solo.
const conWallet = METODOS.concat([
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/4', name: 'Mercado Pago' },
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/5', name: 'Apple Pay' },
]);
r = run(entrada('Transferencia o efectivo', conWallet));
chk(igual(ocultados(r, conWallet), ['Apple Pay', 'Mercado Pago', 'Tarjeta de crédito']),
    'wallets nuevos quedan ocultos sin tocar la funcion: ' + JSON.stringify(ocultados(r, conWallet)));

// Fail-open: si renombraron todo, NO dejar el checkout sin medios de pago.
const renombrados = [
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/9', name: 'Deposito bancario' },
  { id: 'gid://shopify/PaymentCustomizationPaymentMethod/8', name: 'Tarjeta' },
];
r = run(entrada('Transferencia o efectivo', renombrados));
chk(r.operations.length === 0, 'ningun metodo matchea la lista blanca -> no oculta nada (fail-open)');

r = run(entrada('Transferencia o efectivo', []));
chk(r.operations.length === 0, 'sin metodos en el input -> no oculta nada');

r = run(entrada('TRANSFERENCIA O EFECTIVO'));
chk(r.operations.length === 1, 'el match no depende de mayusculas');

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
