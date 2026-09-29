// api/_packs.js
// Productos que se venden de a pack (sliders de a par, kits, etc.).
//
// Regla única del sistema:
//   · stock_dep           → unidades sueltas reales del depósito (las cajas).
//   · unidades_por_venta  → cuántas de esas unidades se van por cada venta.
//   · stock_meli / stock_shopify y lo que se publica → packs completos.
//
// Con sliders: 16 cajas en el depósito y unidades_por_venta = 2 → se publican
// 8 pares, y cada par vendido descuenta 2 del depósito.

function unidadesPorVenta(producto) {
  const n = Number(producto?.unidades_por_venta);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// Packs completos que salen de un stock de depósito. Lo que va a las
// publicaciones: media unidad suelta no se puede vender, por eso el floor.
function packsDisponibles(stockDep, producto) {
  return Math.max(0, Math.floor((Number(stockDep) || 0) / unidadesPorVenta(producto)));
}

// Unidades de depósito que mueve una venta/devolución de `cantidad` packs.
function unidadesDeDeposito(cantidad, producto) {
  return (Number(cantidad) || 0) * unidadesPorVenta(producto);
}

// Normaliza lo que llega del cliente para guardar en la columna.
function parseUnidadesPorVenta(valor) {
  const n = Math.floor(Number(valor));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

module.exports = { unidadesPorVenta, packsDisponibles, unidadesDeDeposito, parseUnidadesPorVenta };
