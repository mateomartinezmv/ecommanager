// api/_proveedores.js
// Reglas de los proveedores (importadores) que no dependen de la pantalla: qué se guarda de
// cada uno, cómo se detecta que la migración todavía no corrió y a qué proveedor queda
// asignado cada producto según sus importaciones.

const MINIMO_USD_DEFAULT = 300;

// Estados de importación que no cuentan para decidir a quién se le compra un producto: un
// pedido cancelado no dice nada de dónde viene la mercadería.
const ESTADOS_IGNORADOS = ['cancelled', 'cancelada'];

function texto(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

// Arma la fila a escribir a partir del cuerpo del request. `parcial` es para el PUT: lo que
// no viene en el cuerpo no se toca (no se pisa con null).
function normalizarProveedor(body, { parcial = false } = {}) {
  const b = body || {};
  const fila = {};
  for (const campo of ['nombre', 'contacto', 'telefono', 'wechat', 'email', 'ubicacion', 'web', 'notas']) {
    if (!parcial || b[campo] !== undefined) fila[campo] = texto(b[campo]);
  }
  if (!parcial || b.minimo_usd !== undefined) {
    const n = Number(b.minimo_usd);
    // Vacío o inválido vuelve al mínimo de siempre en vez de quedar en 0: un 0 silencioso
    // haría que cualquier compra "llegue al mínimo".
    fila.minimo_usd = b.minimo_usd === '' || b.minimo_usd == null || !Number.isFinite(n) || n < 0
      ? MINIMO_USD_DEFAULT
      : Math.round(n * 100) / 100;
  }
  return fila;
}

// ¿El error es "la tabla proveedores o la columna proveedor_id no existen"? Pasa cuando el
// deploy llega antes que la migración. PostgREST devuelve PGRST205 (tabla fuera del cache),
// PGRST204 (columna desconocida en un write) o PGRST200 (relación inexistente); 42P01 y
// 42703 son los mismos errores subiendo crudos de Postgres.
function faltaMigracionProveedores(error) {
  if (!error) return false;
  if (['PGRST205', 'PGRST204', 'PGRST200', '42P01', '42703'].includes(error.code)) return true;
  const msg = String(error.message || '');
  return /proveedor/i.test(msg) && /column|columna|relation|table|tabla|schema/i.test(msg);
}

// A qué proveedor se le compra hoy cada SKU: el de la importación más reciente (por fecha
// de orden) que lo trae y que tiene proveedor cargado. Devuelve { sku: proveedor_id } sólo
// para los SKUs pedidos que tienen alguna importación con proveedor; los demás no se tocan.
function proveedorPorSku(importaciones, skus) {
  const buscados = new Set((skus || []).filter(Boolean));
  const elegido = {}; // sku -> { proveedor_id, fecha, id }
  for (const imp of (importaciones || [])) {
    if (!imp || !imp.proveedor_id || ESTADOS_IGNORADOS.includes(imp.estado)) continue;
    for (const it of (imp.items || [])) {
      const sku = it && String(it.sku || '').trim();
      if (!sku || !buscados.has(sku)) continue;
      const actual = elegido[sku];
      // Desempate por id: es 'IMP<timestamp>', así que dos compras del mismo día quedan en
      // el orden en que se cargaron.
      const masNueva = !actual
        || (imp.fecha || '') > actual.fecha
        || ((imp.fecha || '') === actual.fecha && String(imp.id) > String(actual.id));
      if (masNueva) elegido[sku] = { proveedor_id: imp.proveedor_id, fecha: imp.fecha || '', id: imp.id };
    }
  }
  const res = {};
  for (const [sku, e] of Object.entries(elegido)) res[sku] = e.proveedor_id;
  return res;
}

function skusDeItems(items) {
  return [...new Set((items || []).map(it => String(it?.sku || '').trim()).filter(Boolean))];
}

// Vuelve a calcular el proveedor de los SKUs dados y lo escribe en productos. Se llama al
// crear o editar una importación. Un update por proveedor, no uno por SKU.
async function sincronizarProveedorProductos(supabase, skus) {
  if (!skus.length) return { asignados: 0 };
  const { data: imps, error } = await supabase
    .from('importaciones')
    .select('id, fecha, estado, items, proveedor_id')
    .not('proveedor_id', 'is', null);
  if (error) throw error;

  const porSku = proveedorPorSku(imps, skus);
  const porProveedor = {};
  for (const [sku, prov] of Object.entries(porSku)) (porProveedor[prov] = porProveedor[prov] || []).push(sku);

  let asignados = 0;
  for (const [prov, lista] of Object.entries(porProveedor)) {
    const { data, error: upErr } = await supabase
      .from('productos').update({ proveedor_id: prov }).in('sku', lista).select('sku');
    if (upErr) throw upErr;
    asignados += (data || []).length;
  }
  return { asignados };
}

module.exports = {
  MINIMO_USD_DEFAULT,
  normalizarProveedor,
  faltaMigracionProveedores,
  proveedorPorSku,
  skusDeItems,
  sincronizarProveedorProductos,
};
