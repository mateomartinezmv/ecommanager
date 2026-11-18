// api/_kits.js
// Kits: una publicación que vende varias piezas del depósito juntas (par de espejos alerón +
// protectores de levas). Ver supabase/migrations/20261117000000_add_kits.sql.
//
// Regla del sistema:
//   · Un kit es un producto más (SKU, nombre, precio, costo, publicaciones de MELI) sin cajas
//     propias: kit_componentes dice qué piezas lleva y cuántas unidades del depósito de cada una.
//   · Su stock es el de la pieza que menos alcanza: min(floor(stock_dep / cantidad)). No se
//     carga a mano; la base lo recalcula sola (triggers) cada vez que se mueve una pieza.
//   · Vender un kit descuenta las piezas (descontar_stock ya lo hace en la base).
//   · Las piezas se siguen vendiendo sueltas y comparten el depósito con el kit.
//
// Lo que queda de este lado es saber qué publicaciones hay que volver a empujar a MELI cuando
// algo se mueve: las de las piezas cuando se vende un kit, y las de los kits cuando se vende
// (o vuelve) una pieza. Eso lo usa _stockSync.js.
//
// Si la migración todavía no corrió, la tabla no existe: todo esto responde "no hay kits" y el
// resto del stock funciona como antes.

const TABLA = 'kit_componentes';
const COLS_PRODUCTO = 'sku, nombre, stock_dep, unidades_por_venta, meli_id, meli_ids, shopify_id, discontinuado';

function cantidadValida(valor) {
  const n = Math.floor(Number(valor));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// Kits completos que salen de las piezas. `piezas`: [{ cantidad, stock_dep }]. Sin piezas → 0.
// Es la misma cuenta que stock_kit() en la base.
function stockKit(piezas) {
  if (!Array.isArray(piezas) || !piezas.length) return 0;
  return Math.max(0, Math.min(...piezas.map(p =>
    Math.floor(Math.max(0, Number(p.stock_dep) || 0) / cantidadValida(p.cantidad)))));
}

// Supabase falso de los tests, tabla sin crear, red caída: en cualquiera de esos casos no hay
// kits que mirar, y el movimiento de stock no se puede caer por eso.
async function leer(consulta) {
  try {
    const { data, error } = await consulta();
    if (error) return [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Para un SKU: si es kit, sus piezas; y los kits que lo usan como pieza.
// Devuelve { piezas: [{ sku, cantidad }], kits: [sku] }.
async function relacionesDeKit(supabase, sku) {
  if (!sku) return { piezas: [], kits: [] };
  const [comoKit, comoPieza] = await Promise.all([
    leer(() => supabase.from(TABLA).select('componente_sku, cantidad').eq('kit_sku', sku)),
    leer(() => supabase.from(TABLA).select('kit_sku').eq('componente_sku', sku)),
  ]);
  return {
    piezas: comoKit.map(r => ({ sku: r.componente_sku, cantidad: cantidadValida(r.cantidad) })),
    kits: [...new Set(comoPieza.map(r => r.kit_sku))],
  };
}

// Kits que usan alguna de estas piezas.
async function kitsQueUsan(supabase, skus) {
  const lista = [...new Set((skus || []).filter(Boolean))];
  if (!lista.length) return [];
  const filas = await leer(() => supabase.from(TABLA).select('kit_sku').in('componente_sku', lista));
  return [...new Set(filas.map(r => r.kit_sku))];
}

// Productos frescos (con lo que hace falta para publicar), por SKU.
async function productosPorSku(supabase, skus) {
  const lista = [...new Set((skus || []).filter(Boolean))];
  const mapa = new Map();
  if (!lista.length) return mapa;
  const filas = await leer(() => supabase.from('productos').select(COLS_PRODUCTO).in('sku', lista));
  for (const p of filas) mapa.set(p.sku, p);
  return mapa;
}

// Todas las recetas, agrupadas por kit: { [kitSku]: [{ sku, cantidad }] }. Para la pantalla.
async function todasLasPiezas(supabase) {
  const filas = await leer(() => supabase.from(TABLA).select('kit_sku, componente_sku, cantidad'));
  const porKit = {};
  for (const r of filas) {
    (porKit[r.kit_sku] || (porKit[r.kit_sku] = [])).push({ sku: r.componente_sku, cantidad: cantidadValida(r.cantidad) });
  }
  return porKit;
}

// Normaliza las piezas que llegan del formulario: [{ sku, cantidad }] sin repetidos, sin el
// propio kit y con cantidad entera ≥ 1. Un SKU repetido suma sus cantidades.
function normalizarPiezas(kitSku, piezas) {
  const porSku = new Map();
  for (const p of Array.isArray(piezas) ? piezas : []) {
    const sku = String(p?.sku || '').trim();
    if (!sku || sku === kitSku) continue;
    porSku.set(sku, (porSku.get(sku) || 0) + cantidadValida(p.cantidad));
  }
  return [...porSku].map(([sku, cantidad]) => ({ sku, cantidad }));
}

// Reemplaza las piezas de un kit. `piezas` vacío = deja de ser kit. Lanza con el motivo si la
// base lo rechaza (pieza que no existe, kit dentro de otro kit, tabla sin crear).
async function guardarPiezas(supabase, kitSku, piezas) {
  const nuevas = normalizarPiezas(kitSku, piezas);

  const { error: delErr } = await supabase.from(TABLA).delete().eq('kit_sku', kitSku);
  if (delErr) throw new Error(`No se pudieron guardar las piezas del kit: ${delErr.message}`);
  if (!nuevas.length) return [];

  const { error } = await supabase.from(TABLA).insert(
    nuevas.map(p => ({ kit_sku: kitSku, componente_sku: p.sku, cantidad: p.cantidad }))
  );
  if (error) throw new Error(`No se pudieron guardar las piezas del kit: ${error.message}`);
  return nuevas;
}

module.exports = {
  COLS_PRODUCTO,
  stockKit,
  relacionesDeKit,
  kitsQueUsan,
  productosPorSku,
  todasLasPiezas,
  normalizarPiezas,
  guardarPiezas,
};
