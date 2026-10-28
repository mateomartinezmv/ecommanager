// Pedidos de Shopify → CRM, directo sobre api/shopify/notify.js (sin navegador ni red).
//
// Lo que se protege: que un pedido con pago pendiente (transferencia o efectivo) entre igual
// al CRM —antes sólo se escuchaba orders/paid y esos pedidos se perdían—, con el descuento
// del cupón, el cliente con su teléfono y el envío con la dirección para la etiqueta; que el
// mismo pedido llegando varias veces baje el stock una sola vez; que al cobrarse pase a
// "pagada"; y que al cancelarse devuelva la mercadería.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// El stock se mueve contra MELI y Shopify: acá se reemplaza por uno que sólo anota.
const movimientos = [];
const stockSyncPath = path.join(__dirname, '../api/_stockSync.js');
require.cache[stockSyncPath] = {
  id: stockSyncPath, filename: stockSyncPath, loaded: true,
  exports: {
    sincronizarStock: async (supabase, producto, nuevo) => {
      movimientos.push({ sku: producto.sku, nuevo });
      const p = supabase._tablas.productos.find(x => x.sku === producto.sku);
      p.stock_dep = nuevo;
      return { stockDep: nuevo, stockPublicado: nuevo, meli: { sincronizadas: [], errores: [] }, shopify: {} };
    },
    resumenSync: (sku, s) => `${sku}: ${s.stockDep}`,
  },
};

const { procesarOrden, estadoDeOrden, importesDeLinea, direccionDeOrden } = require('../api/shopify/notify');

// Lo justo de PostgREST que usa el módulo.
function fakeSupabase(tablas) {
  class Q {
    constructor(t) { this.t = t; this.filtros = []; this.op = 'select'; }
    select() { return this; }
    eq(c, v) { this.filtros.push(r => String(r[c]) === String(v)); return this; }
    like(c, v) { const re = new RegExp('^' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); this.filtros.push(r => re.test(r[c])); return this; }
    limit() { return this; }
    filas() { return tablas[this.t].filter(r => this.filtros.every(f => f(r))); }
    insert(fila) {
      if (tablas[this.t].some(r => r.id === fila.id)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
      tablas[this.t].push({ ...fila });
      return Promise.resolve({ error: null });
    }
    update(cambios) { this.op = 'update'; this.cambios = cambios; return this; }
    delete() { this.op = 'delete'; return this; }
    maybeSingle() { return Promise.resolve({ data: this.filas()[0] || null, error: null }); }
    then(ok, mal) {
      let r;
      if (this.op === 'update') { this.filas().forEach(f => Object.assign(f, this.cambios)); r = { error: null }; }
      else if (this.op === 'delete') { const fuera = new Set(this.filas()); tablas[this.t] = tablas[this.t].filter(f => !fuera.has(f)); r = { error: null }; }
      else r = { data: this.filas(), error: null };
      return Promise.resolve(r).then(ok, mal);
    }
  }
  return { _tablas: tablas, from: t => new Q(t) };
}

// Como el pedido #MM1013: transferencia pendiente, cupón CONTADO10, envío en el día.
function pedido(extra = {}) {
  return {
    id: 6950000000001, name: '#MM1013', order_number: 1013,
    created_at: '2026-10-28T15:03:00-03:00',
    financial_status: 'pending', cancelled_at: null,
    payment_gateway_names: ['Transferencia Bancaria'],
    customer: { id: 777, first_name: 'Andres', last_name: 'Chamorro', phone: null, email: 'andres@example.com' },
    shipping_address: { name: 'Andres Chamorro', address1: 'Defensa 1827', address2: 'Apto 201', city: 'Montevideo', province: 'Montevideo', zip: '11000', phone: '+598 96 883 838' },
    shipping_lines: [{ title: 'Envíos en el día - Montevideo', code: 'Envíos en el día - Montevideo' }],
    line_items: [{ variant_id: 47397889507515, sku: 'CPJ-62001', title: 'Porta Matricula', quantity: 1, price: '1290.00',
      discount_allocations: [{ amount: '129.00' }] }],
    ...extra,
  };
}

function base() {
  return fakeSupabase({
    productos: [{ sku: 'CPJ-62001', nombre: 'Porta Matricula Rebatible', shopify_id: '47397889507515', stock_dep: 10, unidades_por_venta: 1 }],
    ventas: [], envios: [], clientes: [], ventas_canceladas: [],
  });
}

test('estado de la venta según el cobro de Shopify', () => {
  assert.strictEqual(estadoDeOrden({ financial_status: 'pending' }), 'pendiente');
  assert.strictEqual(estadoDeOrden({ financial_status: 'authorized' }), 'pendiente');
  assert.strictEqual(estadoDeOrden({ financial_status: 'paid' }), 'pagada');
  assert.strictEqual(estadoDeOrden({ financial_status: 'paid', cancelled_at: '2026-10-28' }), 'cancelada');
});

test('el total de la línea descuenta el cupón', () => {
  assert.deepStrictEqual(importesDeLinea(pedido().line_items[0]),
    { precio: 1290, cantidad: 1, descuentoMonto: 129, descuentoPct: 10, total: 1161 });
});

test('la dirección de envío no repite la ciudad', () => {
  assert.strictEqual(direccionDeOrden(pedido()), 'Defensa 1827, Apto 201, Montevideo');
});

test('un pedido con pago pendiente entra al CRM con cliente y envío', async () => {
  movimientos.length = 0;
  const sb = base();
  await procesarOrden(pedido(), sb, []);
  const t = sb._tablas;

  assert.strictEqual(t.ventas.length, 1);
  const v = t.ventas[0];
  assert.strictEqual(v.canal, 'shopify');
  assert.strictEqual(v.estado, 'pendiente');
  assert.strictEqual(v.metodo_pago, 'transferencia');
  assert.strictEqual(v.fecha, '2026-10-28');
  assert.strictEqual(Number(v.total), 1161);
  assert.strictEqual(Number(v.descuento_monto), 129);

  assert.strictEqual(t.clientes.length, 1);
  assert.strictEqual(t.clientes[0].telefono, '+598 96 883 838', 'el teléfono de la etiqueta sale de la ficha');
  assert.strictEqual(v.cliente_id, t.clientes[0].id);

  assert.strictEqual(t.envios.length, 1);
  const e = t.envios[0];
  assert.strictEqual(e.venta_id, v.id);
  assert.strictEqual(e.orden, '#MM1013');
  assert.strictEqual(e.direccion, 'Defensa 1827, Apto 201, Montevideo');
  assert.strictEqual(e.estado, 'pendiente');

  assert.deepStrictEqual(movimientos, [{ sku: 'CPJ-62001', nuevo: 9 }]);
});

test('el mismo pedido varias veces baja el stock una sola vez; al cobrarse pasa a pagada', async () => {
  movimientos.length = 0;
  const sb = base();
  await procesarOrden(pedido(), sb, null);              // orders/create
  await procesarOrden(pedido(), sb, null);              // reintento / sincronización
  await procesarOrden(pedido({ financial_status: 'paid' }), sb, null); // orders/paid
  const t = sb._tablas;
  assert.strictEqual(t.ventas.length, 1);
  assert.strictEqual(t.ventas[0].estado, 'pagada');
  assert.strictEqual(t.envios.length, 1);
  assert.strictEqual(t.clientes.length, 1);
  assert.strictEqual(movimientos.length, 1);
  assert.strictEqual(t.productos[0].stock_dep, 9);
});

test('un estado cambiado a mano en el CRM no se pisa', async () => {
  const sb = base();
  await procesarOrden(pedido(), sb, null);
  sb._tablas.ventas[0].estado = 'pagada'; // la transferencia se vio en el banco antes que en Shopify
  await procesarOrden(pedido(), sb, null);
  assert.strictEqual(sb._tablas.ventas[0].estado, 'pagada');
});

test('cancelar el pedido devuelve la mercadería y saca el envío pendiente', async () => {
  movimientos.length = 0;
  const sb = base();
  await procesarOrden(pedido(), sb, null);
  await procesarOrden(pedido({ cancelled_at: '2026-10-29T10:00:00-03:00' }), sb, null);
  await procesarOrden(pedido({ cancelled_at: '2026-10-29T10:00:00-03:00' }), sb, null);
  const t = sb._tablas;
  assert.strictEqual(t.ventas[0].estado, 'cancelada');
  assert.strictEqual(t.productos[0].stock_dep, 10, 'vuelve una sola vez');
  assert.strictEqual(t.envios.length, 0);
});

test('una venta borrada a mano en el CRM no vuelve con la sincronización', async () => {
  movimientos.length = 0;
  const sb = base();
  sb._tablas.ventas_canceladas.push({ venta_id: `V_SHOP_${pedido().id}_47397889507515` });
  await procesarOrden(pedido(), sb, null);
  assert.strictEqual(sb._tablas.ventas.length, 0);
  assert.strictEqual(sb._tablas.envios.length, 0);
  assert.strictEqual(movimientos.length, 0);
});

test('retiro en el local: venta sin envío', async () => {
  const sb = base();
  await procesarOrden(pedido({ shipping_lines: [{ title: 'Retiro en local', code: 'pickup' }] }), sb, null);
  assert.strictEqual(sb._tablas.ventas.length, 1);
  assert.strictEqual(sb._tablas.envios.length, 0);
});

test('varios productos en el pedido: un carrito con un solo envío', async () => {
  const sb = base();
  sb._tablas.productos.push({ sku: '2004-107', nombre: 'Baúl', shopify_id: '47397889835195', stock_dep: 3, unidades_por_venta: 1 });
  const p = pedido();
  p.line_items.push({ variant_id: 47397889835195, sku: '2004-107', quantity: 1, price: '2290.00', discount_allocations: [] });
  await procesarOrden(p, sb, null);
  const t = sb._tablas;
  assert.strictEqual(t.ventas.length, 2);
  assert.ok(t.ventas.every(v => v.venta_grupo === `SHOP_${p.id}`));
  assert.strictEqual(t.envios.length, 1);
  assert.match(t.envios[0].producto, /Porta Matricula Rebatible x1 \+ Baúl x1/);
});
