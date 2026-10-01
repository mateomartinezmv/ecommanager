// @ts-check
//
// Oculta los medios de pago con tarjeta cuando el cliente eligio "Transferencia
// o efectivo" en el carrito y por lo tanto ya se llevo el 10% de descuento.
//
// El atributo lo escribe snippets/precio-contado-carrito.liquid del theme con
// POST /cart/update.js. Si cambias el texto ahi, cambialo aca.

const ATRIBUTO_VALOR_CONTADO = 'transferencia';

// Lista blanca, no lista negra: con contado se deja SOLO lo que matchee esto y
// se oculta todo lo demas. Asi, si manana se agrega MercadoPago, Apple Pay o
// cualquier wallet nuevo, queda oculto solo por existir, sin tocar la funcion.
const PERMITIDOS_CON_CONTADO = ['transferencia', 'efectivo'];

const SIN_CAMBIOS = { operations: [] };

/**
 * @param {string | null | undefined} texto
 * @returns {string}
 */
function normalizar(texto) {
  // Sin String.prototype.normalize: el runtime de Functions es QuickJS y no
  // garantiza soporte Unicode completo. Las palabras que se comparan no llevan
  // tilde, asi que alcanza con minusculas.
  return (texto || '').toLowerCase();
}

/**
 * @param {{name?: string | null}} metodo
 * @returns {boolean}
 */
function esPermitidoConContado(metodo) {
  const nombre = normalizar(metodo && metodo.name);
  for (let i = 0; i < PERMITIDOS_CON_CONTADO.length; i++) {
    if (nombre.indexOf(PERMITIDOS_CON_CONTADO[i]) !== -1) return true;
  }
  return false;
}

/**
 * @param {any} input
 * @returns {any}
 */
export function cartPaymentMethodsTransformRun(input) {
  const elegido = normalizar(input && input.cart && input.cart.attribute && input.cart.attribute.value);

  // No eligio contado: no se toca nada. Pagar por transferencia sin el descuento
  // no perjudica al negocio, asi que no hace falta restringir el otro sentido.
  if (elegido.indexOf(ATRIBUTO_VALOR_CONTADO) === -1) return SIN_CAMBIOS;

  const metodos = (input && input.paymentMethods) || [];
  const permitidos = metodos.filter(esPermitidoConContado);

  // Red de seguridad: si ningun metodo matchea la lista blanca (los renombraron,
  // los desactivaron, el input vino raro), ocultar "todo lo demas" dejaria el
  // checkout sin ninguna forma de pagar. Antes que eso, no hacer nada.
  if (permitidos.length === 0) return SIN_CAMBIOS;

  const operations = metodos
    .filter(function (metodo) { return !esPermitidoConContado(metodo); })
    .map(function (metodo) {
      return { paymentMethodHide: { paymentMethodId: metodo.id } };
    });

  return operations.length > 0 ? { operations } : SIN_CAMBIOS;
}
