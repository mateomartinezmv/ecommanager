// api/_fechas.js
// El día de una venta, en hora de Montevideo.
//
// MELI manda los horarios en -04:00, una hora menos que Uruguay: una venta de las 00:30 llega
// como "23:30 del día anterior", y cortar el texto en los primeros 10 caracteres la dejaba en
// el día anterior (y en el resumen equivocado). Shopify los manda en la zona de la tienda.
// Acá se convierte el instante a la fecha de Montevideo, venga en la zona que venga.

const ZONA = 'America/Montevideo';

function fechaEnUruguay(instante = new Date()) {
  const d = instante instanceof Date ? instante : new Date(instante || Date.now());
  const valida = Number.isNaN(d.getTime()) ? new Date() : d;
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(valida);
}

module.exports = { fechaEnUruguay };
