// @ts-check
//
// Deja en el checkout solo los medios de pago coherentes con lo que el cliente
// eligio en el carrito:
//
//   "Transferencia o efectivo"  -> oculta tarjetas y wallets (ya se llevo el 10%)
//   "Tarjeta o cuotas"          -> oculta transferencia y efectivo
//   sin atributo                -> no oculta nada
//
// El tercer caso importa: "Comprar ahora" y los wallets saltean el carrito, asi
// que llegan al checkout sin atributo. Ocultar algo ahi dejaria al cliente sin
// la forma de pago que queria, por una eleccion que nunca le ofrecimos.
//
// El atributo lo escribe snippets/precio-contado-carrito.liquid del theme con
// POST /cart/update.js. Si cambias esos textos ahi, cambialos aca.

const MARCA_CONTADO = 'transferencia';
const MARCA_TARJETA = 'tarjeta';

// Que cuenta como medio de pago "contado". Es lista blanca: un wallet nuevo
// (MercadoPago, Apple Pay) no matchea, asi que cae del lado tarjeta solo por
// existir, en vez de colarse por no estar prohibido.
const MEDIOS_CONTADO = ['transferencia', 'efectivo'];

const SIN_CAMBIOS = { operations: [] };

/**
 * @param {string | null | undefined} texto
 * @returns {string}
 */
function normalizar(texto) {
  // Sin String.prototype.normalize: el runtime de Functions es QuickJS y no
  // garantiza soporte Unicode completo. Las palabras comparadas no llevan tilde.
  return (texto || '').toLowerCase();
}

/**
 * @param {{name?: string | null}} metodo
 * @returns {boolean}
 */
function esMedioContado(metodo) {
  const nombre = normalizar(metodo && metodo.name);
  for (let i = 0; i < MEDIOS_CONTADO.length; i++) {
    if (nombre.indexOf(MEDIOS_CONTADO[i]) !== -1) return true;
  }
  return false;
}

/**
 * Oculta `aOcultar`, pero solo si queda algo con que pagar.
 * @param {Array<any>} aOcultar
 * @param {Array<any>} aDejar
 * @returns {any}
 */
function ocultar(aOcultar, aDejar) {
  // Red de seguridad: si no reconocemos ningun medio para dejar visible (los
  // renombraron, los desactivaron, el input vino raro), ocultar seria dejar el
  // checkout sin ninguna forma de pagar. Antes que eso, no hacer nada.
  if (aDejar.length === 0 || aOcultar.length === 0) return SIN_CAMBIOS;

  return {
    operations: aOcultar.map(function (metodo) {
      return { paymentMethodHide: { paymentMethodId: metodo.id } };
    })
  };
}

/**
 * @param {any} input
 * @returns {any}
 */
export function cartPaymentMethodsTransformRun(input) {
  const elegido = normalizar(input && input.cart && input.cart.attribute && input.cart.attribute.value);
  const metodos = (input && input.paymentMethods) || [];

  const contado = [];
  const resto = [];
  for (let i = 0; i < metodos.length; i++) {
    (esMedioContado(metodos[i]) ? contado : resto).push(metodos[i]);
  }

  if (elegido.indexOf(MARCA_CONTADO) !== -1) {
    return ocultar(resto, contado);
  }

  if (elegido.indexOf(MARCA_TARJETA) !== -1) {
    return ocultar(contado, resto);
  }

  // Sin eleccion: el cliente nunca paso por el carrito. No restringir nada.
  return SIN_CAMBIOS;
}
