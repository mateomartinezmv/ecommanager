// Una orden descuenta stock una sola vez aunque lleguen varios avisos a la vez.
//
// MELI manda 5-7 avisos orders_v2 por orden, varios en el mismo segundo. El webhook
// descontaba antes de registrar la venta, así que cada aviso que entraba en el medio volvía
// a restar: una venta de 1 unidad de ALERONFINOSNK bajó el depósito de 9 a 6 (27/10/2026).
// Ahora la venta se inserta primero (la clave primaria deja pasar a uno solo) y la resta la
// hace la base en un paso (descontar_stock). La base es un Supabase falso en memoria, con
// demoras para que los avisos se intercalen como en producción.

const { test } = require('node:test');
const assert = require('node:assert');

const { ventaNueva, descontarStock } = require('../api/_stockSync');
const { unidadesDeDeposito } = require('../api/_packs');

const pausa = () => new Promise(r => setTimeout(r, Math.random() * 5));

function supabaseFalso(productos) {
  const ventas = new Map();
  return {
    ventas,
    from(tabla) {
      return {
        async insert(fila) {
          await pausa();
          if (tabla !== 'ventas') return { error: null };
          if (ventas.has(fila.id)) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint "ventas_pkey"' } };
          }
          ventas.set(fila.id, fila);
          return { error: null };
        },
      };
    },
    // Igual que la función SQL: resta y espejo en un solo paso, sin leer antes.
    async rpc(nombre, { p_sku, p_unidades }) {
      await pausa();
      const p = productos[p_sku];
      if (!p) return { data: null, error: null };
      p.stock_dep = Math.max(0, p.stock_dep - p_unidades);
      p.stock_meli = p.stock_shopify = Math.floor(p.stock_dep / (p.unidades_por_venta || 1));
      return { data: p.stock_dep, error: null };
    },
  };
}

// Lo que hace api/meli/notify.js con cada ítem de la orden.
async function procesarAviso(supabase, producto, orden, cantidad) {
  const alta = await ventaNueva(supabase, { id: `V_MELI_${orden}_MLU1`, sku: producto.sku, cantidad });
  if (alta.error || !alta.nueva) return false;
  await descontarStock(supabase, producto, unidadesDeDeposito(cantidad, producto));
  return true;
}

test('seis avisos simultáneos de la misma orden descuentan una sola vez', async () => {
  const productos = { ALERONFINOSNK: { sku: 'ALERONFINOSNK', stock_dep: 9, unidades_por_venta: 1 } };
  const supabase = supabaseFalso(productos);
  // El producto que lee cada aviso es una foto vieja: no tiene que importar.
  const foto = { ...productos.ALERONFINOSNK };

  const descontaron = await Promise.all(
    Array.from({ length: 6 }, () => procesarAviso(supabase, foto, '2000019202906468', 1))
  );

  assert.strictEqual(descontaron.filter(Boolean).length, 1, 'un solo aviso registra y descuenta');
  assert.strictEqual(supabase.ventas.size, 1);
  assert.strictEqual(productos.ALERONFINOSNK.stock_dep, 8);
});

test('órdenes distintas del mismo SKU a la vez no se pisan', async () => {
  const productos = { ALERONFINOSNK: { sku: 'ALERONFINOSNK', stock_dep: 9, unidades_por_venta: 1 } };
  const supabase = supabaseFalso(productos);
  const foto = { ...productos.ALERONFINOSNK };

  // Tres órdenes, cada una con tres avisos repetidos, todo intercalado.
  const avisos = [];
  for (const orden of ['A', 'B', 'C']) for (let i = 0; i < 3; i++) avisos.push(procesarAviso(supabase, foto, orden, 1));
  await Promise.all(avisos);

  assert.strictEqual(supabase.ventas.size, 3);
  assert.strictEqual(productos.ALERONFINOSNK.stock_dep, 6);
});

test('packs: un par vendido descuenta 2 del depósito y publica pares completos', async () => {
  const productos = { SLIDER: { sku: 'SLIDER', stock_dep: 7, unidades_por_venta: 2 } };
  const supabase = supabaseFalso(productos);

  const r = await descontarStock(supabase, { ...productos.SLIDER }, unidadesDeDeposito(1, productos.SLIDER));

  assert.strictEqual(r.stockDep, 5);
  assert.strictEqual(r.stockPublicado, 2);
  assert.strictEqual(productos.SLIDER.stock_meli, 2);
});

test('si la venta no se pudo guardar, el stock no se toca', async () => {
  const productos = { X: { sku: 'X', stock_dep: 4, unidades_por_venta: 1 } };
  const supabase = supabaseFalso(productos);
  supabase.from = () => ({ insert: async () => ({ error: { code: '23502', message: 'null value in column "fecha"' } }) });

  const descontó = await procesarAviso(supabase, productos.X, 'Z', 1);

  assert.strictEqual(descontó, false);
  assert.strictEqual(productos.X.stock_dep, 4);
});
