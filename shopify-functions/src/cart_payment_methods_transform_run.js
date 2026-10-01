// @ts-check
//
// Deja en el checkout solo los medios de pago coherentes con el precio que el
// cliente esta por pagar.
//
// La senal principal es EL DESCUENTO, no el atributo del carrito. El checkout
// muestra el chip "CONTADO10" con una X: si el cliente lo saca ahi, el total
// vuelve al precio de lista y tiene que poder pagar con tarjeta. Mirando solo
// el atributo quedaba atrapado pagando precio lleno por transferencia.
//
//   hay descuento                -> solo transferencia y efectivo
//   sin descuento, pero eligio   -> solo tarjeta y wallets
//   sin descuento y sin eleccion -> no se oculta nada
//
// El tercer caso importa: "Comprar ahora" y los wallets saltean el carrito, asi
// que llegan sin atributo y sin descuento. Ocultar algo ahi seria quitarle una
// forma de pago por una decision que nunca se le ofrecio.

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
 * Descuento sobre los productos. Se excluyen los de envio: el "envio GRATIS"
 * de la tienda es un descuento tambien, y contarlo dejaria la tarjeta oculta
 * siempre.
 * @param {Array<any>} aplicaciones
 * @returns {boolean}
 */
function hayDescuentoEnProductos(aplicaciones) {
  for (let i = 0; i < (aplicaciones || []).length; i++) {
    const tipo = normalizar(aplicaciones[i] && aplicaciones[i].targetType);
    if (tipo.indexOf('shipping') === -1) return true;
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
  // Red de seguridad: si al ocultar no quedaria ningun medio visible, no hacer
  // nada. Antes eso que dejar el checkout sin forma de pagar.
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
  const carrito = (input && input.cart) || {};
  const metodos = (input && input.paymentMethods) || [];

  const contado = [];
  const resto = [];
  for (let i = 0; i < metodos.length; i++) {
    (esMedioContado(metodos[i]) ? contado : resto).push(metodos[i]);
  }

  if (hayDescuentoEnProductos(carrito.discountApplications)) {
    return ocultar(resto, contado);
  }

  // Sin descuento. Si en algun momento eligio en el carrito, esta pagando
  // precio de lista a proposito: se le deja la tarjeta y se oculta el contado,
  // para que no parezca que puede pagar por transferencia sin el 10%.
  const eligio = normalizar(carrito.attribute && carrito.attribute.value);
  if (eligio) {
    return ocultar(contado, resto);
  }

  return SIN_CAMBIOS;
}
