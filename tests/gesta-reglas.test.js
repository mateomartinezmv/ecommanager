// Facturación de las ventas MELI con Gesta, sin navegador: qué ventas salen en el Excel y
// cómo (public/gesta.js), cómo se reconoce a qué venta va el PDF de un eTicket, y qué hace
// /api/meli/factura al subirlo a MELI (api/meli/factura.js, con Supabase y MELI falsos).
//
// Los formatos salen de importar a mano en Gesta (4/11/2026): ver el encabezado de gesta.js.

const { test } = require('node:test');
const assert = require('node:assert');

const Gesta = require('../public/gesta');
const { pdfDesdeBase64, packDeVenta, nombrePdf, subirFacturaMeli, MAX_PDF_BYTES } = require('../api/meli/_facturaMeli');
const { handler } = require('../api/meli/factura');

// ── Datos ────────────────────────────────────────────────────────────────────
// Ventas y productos como los deja normVenta/normProducto en el front.
const productos = [
  { sku: 'HP-HS010', nombre: 'Guardamanos LED', codigoGesta: 15 },
  { sku: 'HP-Q0211', nombre: 'Guardamanos ABS Negro', codigoGesta: 17 },
  { sku: 'HP-Q0212', nombre: 'Guardamanos ABS Azul', codigoGesta: 16 },
  { sku: 'EXT-ESP-8F-8F-001', nombre: 'Extensor espejo', codigoGesta: null },
];
const venta = (o) => ({ canal: 'meli', estado: 'pagada', facturada: null, cantidad: 1, comprador: 'COMPRADOR', ...o });
const ventas = [
  // La venta de la primera prueba: MELI cobró $990 − $133,88 de descuento = $856,12.
  venta({ id: 'V_MELI_2000019330678458_A', fecha: '2026-11-04', ordenMeli: '2000019330678458', packId: '2000015855586013',
    sku: 'HP-HS010', producto: 'Guardamanos Moto Con Señalero LED Integrado Negro', precioUnit: 856.12, total: 856.12 }),
  venta({ id: 'V_MELI_2000019328655326_B', fecha: '2026-11-04', ordenMeli: '2000019328655326', packId: '2000015853536563',
    sku: 'HP-Q0211', producto: 'Guardamanos ABS - Negro', precioUnit: 635.84, total: 635.84 }),
  // Carrito: dos órdenes, un pack.
  venta({ id: 'V_MELI_1_C1', fecha: '2026-11-03', ordenMeli: '1000000000000001', packId: '2000015851965481',
    sku: 'HP-Q0212', producto: 'Guardamanos ABS - Azul', cantidad: 2, precioUnit: 635.84, total: 1271.68 }),
  venta({ id: 'V_MELI_2_C2', fecha: '2026-11-03', ordenMeli: '1000000000000002', packId: '2000015851965481',
    sku: 'HP-Q0211', producto: 'Guardamanos ABS - Negro', precioUnit: 600, total: 600 }),
  // Sin pack: el número de la venta es el de la orden.
  venta({ id: 'V_MELI_3_D', fecha: '2026-11-05', ordenMeli: '2000019999999999', packId: null,
    sku: 'HP-HS010', producto: 'Guardamanos LED', precioUnit: 990, total: 990 }),
  // Producto que no está en Gesta, a propósito.
  venta({ id: 'V_MELI_4_E', fecha: '2026-11-05', ordenMeli: '2000018888888888', packId: null,
    sku: 'EXT-ESP-8F-8F-001', producto: 'Extensor espejo', precioUnit: 100, total: 100 }),
  // Ya facturada, cancelada, anterior a la fecha de corte y de mostrador: no salen.
  venta({ id: 'V_MELI_5', fecha: '2026-11-05', ordenMeli: '2000017777777777', sku: 'HP-HS010', producto: 'x', precioUnit: 990, total: 990, facturada: true }),
  venta({ id: 'V_MELI_6', fecha: '2026-11-05', ordenMeli: '2000016666666666', sku: 'HP-HS010', producto: 'x', precioUnit: 990, total: 990, estado: 'cancelada' }),
  venta({ id: 'V_MELI_7', fecha: '2026-10-30', ordenMeli: '2000015555555555', sku: 'HP-HS010', producto: 'x', precioUnit: 990, total: 990 }),
  { id: 'V-MOS', canal: 'mostrador', fecha: '2026-11-05', sku: 'HP-HS010', producto: 'x', cantidad: 1, precioUnit: 990, total: 990, estado: 'pagada' },
];

// ── Qué sale en el Excel ─────────────────────────────────────────────────────
test('salen las ventas MELI sin facturar desde la fecha de corte, una por venta', () => {
  const { comprobantes } = Gesta.pendientesGesta(ventas, productos, { desde: '2026-11-03' });
  assert.deepStrictEqual(comprobantes.map(c => c.ref),
    ['2000015853536563', '2000015855586013', '2000019999999999']);
});

test('el número de la venta es el pack, o la orden cuando no hay carrito', () => {
  const { comprobantes } = Gesta.pendientesGesta(ventas, productos, { desde: '2026-11-03' });
  assert.strictEqual(comprobantes.find(c => c.lineas[0].id === 'V_MELI_2000019330678458_A').ref, '2000015855586013');
  assert.strictEqual(comprobantes.find(c => c.lineas[0].id === 'V_MELI_3_D').ref, '2000019999999999');
});

test('un carrito no sale en el Excel: Gesta se cae con más de una fila a consumidor final', () => {
  const { comprobantes, excluidas } = Gesta.pendientesGesta(ventas, productos, { desde: '2026-11-03' });
  assert.ok(!comprobantes.some(c => c.ref === '2000015851965481'));
  const e = excluidas.find(x => x.ref === '2000015851965481');
  assert.strictEqual(e.manual, true, 'se factura a mano y se marca desde la pantalla');
  assert.strictEqual(e.lineas.length, 2);
  assert.strictEqual(e.total, 1871.68);
  assert.match(e.motivo, /Carrito de 2 productos: .*Facturalo a mano en Gesta/);
});

test('cada Excel tiene una sola fila, también con varias unidades del mismo producto', () => {
  const dos = [venta({ id: 'U', fecha: '2026-11-05', ordenMeli: '2000013333333333', sku: 'HP-Q0211', producto: 'Guardamanos ABS - Negro', cantidad: 2, precioUnit: 635.84, total: 1271.68 })];
  const { comprobantes } = Gesta.pendientesGesta(dos, productos, { desde: '2026-11-03' });
  assert.strictEqual(Gesta.filasExcel(comprobantes[0]).length, 2, 'encabezado + una fila');
  assert.deepStrictEqual(comprobantes[0].filas, [{ codigo: 17, detalle: 'Guardamanos ABS - Negro', cantidad: 2, precio: 635.84 }]);
});

test('el producto que no está en Gesta deja la venta afuera, con el motivo', () => {
  const { comprobantes, excluidas } = Gesta.pendientesGesta(ventas, productos, { desde: '2026-11-03' });
  assert.ok(!comprobantes.some(c => c.ref === '2000018888888888'));
  const sinCodigo = excluidas.find(e => e.ref === '2000018888888888');
  assert.match(sinCodigo.motivo, /Sin código de Gesta: Extensor espejo \(EXT-ESP-8F-8F-001\)/);
  assert.ok(!sinCodigo.manual, 'no se ofrece marcarla: no está en Gesta');
});

test('si las filas no suman el total de la venta, no sale (el eTicket tiene que dar lo de MELI)', () => {
  const rota = [venta({ id: 'R', fecha: '2026-11-05', ordenMeli: '2000014444444444', sku: 'HP-HS010', producto: 'x', cantidad: 3, precioUnit: 333.33, total: 1000 })];
  const { comprobantes, excluidas } = Gesta.pendientesGesta(rota, productos, { desde: '2026-11-03' });
  assert.strictEqual(comprobantes.length, 0);
  assert.match(excluidas[0].motivo, /suman \$999.99 y la venta \$1000/);
});

test('sin fecha de corte se usa la de arranque (antes se facturaba a mano)', () => {
  const { comprobantes } = Gesta.pendientesGesta(ventas, productos);
  assert.strictEqual(Gesta.DESDE_DEFAULT, '2026-11-03');
  assert.ok(!comprobantes.some(c => c.ref === '2000015555555555'));
});

// ── El Excel ─────────────────────────────────────────────────────────────────
test('el Excel tiene las columnas de la plantilla de Gesta y la venta como consumidor final', () => {
  const { comprobantes } = Gesta.pendientesGesta(ventas, productos, { desde: '2026-11-03' });
  const filas = Gesta.filasExcel(comprobantes.find(c => c.ref === '2000015855586013'));
  assert.deepStrictEqual(filas[0], ['TIPO', 'FECHA', 'TIPO DOCUMENTO', 'DOCUMENTO', 'MONEDA', 'FORMA DE PAGO',
    'VENCIMIENTO', 'CÓDIGO PRODUCTO', 'DETALLE PRODUCTO', 'DETALLE ADICIONAL', 'CANTIDAD', 'PRECIO UNITARIO', 'DESCUENTO', 'ADENDA']);
  // La misma fila que importó bien a mano: 1 × 856,12, sin descuento, sin documento.
  assert.deepStrictEqual(filas[1], ['eTicket', 46330, null, null, 'UYU', 'Contado', null, 15,
    'Guardamanos Moto Con Señalero LED Integrado Negro', null, 1, 856.12, null, 'Venta Mercado Libre #2000015855586013']);
  assert.strictEqual(filas.length, 2);
  assert.strictEqual(Gesta.nombreArchivo({ ref: '2000015855586013' }), 'gesta-2000015855586013.xlsx');
});

test('la fecha va como número de serie de Excel (Gesta rechaza la fecha como texto)', () => {
  assert.strictEqual(Gesta.fechaSerialExcel('2026-11-04'), 46330);
  assert.strictEqual(Gesta.fechaSerialExcel('2024-01-01'), 45292);
  assert.strictEqual(Gesta.fechaSerialExcel('2026-03-01'), 46082);
});

// ── Reconocer el PDF del eTicket ─────────────────────────────────────────────
// Texto como lo saca pdf.js de un eTicket de Gesta: palabras sueltas separadas por espacios.
const textoPdf = (ref, total) => `MARTINEZ VEGA MATEO RUT 219999990011 e-Ticket A 414 Fecha 04/11/2026
  Guardamanos Protector 1 ${total} Subtotal ${total} TOTAL $ ${total} Adenda Venta Mercado Libre # ${ref}`;

test('el PDF se reconoce por la adenda, con el total de la venta', () => {
  const v = Gesta.ventaDePdf(textoPdf('2000015853536563', '635,84'), ventas);
  assert.strictEqual(v.ref, '2000015853536563');
  assert.strictEqual(v.lineas[0].id, 'V_MELI_2000019328655326_B');
  assert.strictEqual(v.totalEnPdf, true);
});

test('el número de la orden también reconoce la venta (el panel de MELI muestra los dos)', () => {
  const v = Gesta.ventaDePdf('eTicket ... Venta Mercado Libre #2000019330678458 TOTAL 856,12', ventas);
  assert.strictEqual(v.ref, '2000015855586013');
  assert.strictEqual(v.totalEnPdf, true);
});

test('un carrito se reconoce entero y el total es el de todas sus líneas', () => {
  const v = Gesta.ventaDePdf(textoPdf('2000015851965481', '1.871,68'), ventas);
  assert.strictEqual(v.lineas.length, 2);
  assert.strictEqual(v.total, 1871.68);
  assert.strictEqual(v.totalEnPdf, true);
});

test('avisa si el total del PDF no es el de la venta', () => {
  const v = Gesta.ventaDePdf(textoPdf('2000015853536563', '890,00'), ventas);
  assert.strictEqual(v.totalEnPdf, false);
});

test('un PDF sin número de venta del CRM no se asigna a ninguna', () => {
  assert.strictEqual(Gesta.ventaDePdf('e-Ticket A 413 TOTAL 1.490,00 RUT 219999990011', ventas), null);
});

test('los montos se buscan en los formatos en que puede salir impreso', () => {
  assert.deepStrictEqual(Gesta.formatosMonto(1373), ['1.373,00', '1373,00', '1,373.00', '1373.00']);
  assert.deepStrictEqual(Gesta.formatosMonto(635.84), ['635,84', '635.84']);
});

// ── El PDF que se manda a MELI ───────────────────────────────────────────────
const pdfFalso = (extra = '') => Buffer.from('%PDF-1.4\n% eTicket\n' + extra + '%%EOF');

test('sólo se acepta un PDF de hasta 1 MB', () => {
  assert.strictEqual(pdfDesdeBase64(pdfFalso().toString('base64')).subarray(0, 5).toString(), '%PDF-');
  assert.strictEqual(pdfDesdeBase64('data:application/pdf;base64,' + pdfFalso().toString('base64')).length, pdfFalso().length);
  assert.throws(() => pdfDesdeBase64(''), /No llegó ningún PDF/);
  assert.throws(() => pdfDesdeBase64(Buffer.from('hola').toString('base64')), /no es un PDF/);
  assert.throws(() => pdfDesdeBase64(pdfFalso('x'.repeat(MAX_PDF_BYTES)).toString('base64')), /acepta hasta 1 MB/);
});

test('el paquete de MELI es el pack, o la orden si no hay carrito', () => {
  assert.strictEqual(packDeVenta({ pack_id: '2000015853536563', orden_meli: '2000019328655326' }), '2000015853536563');
  assert.strictEqual(packDeVenta({ pack_id: null, orden_meli: '2000019999999999' }), '2000019999999999');
  assert.strictEqual(packDeVenta({}), null);
  assert.strictEqual(nombrePdf('eTicket A 414', '1'), 'eTicket A 414.pdf');
  assert.strictEqual(nombrePdf('', '123'), 'factura-123.pdf');
});

test('se sube a /packs/{pack}/fiscal_documents como multipart, en el campo fiscal_document', async () => {
  let pedido;
  const fetchImpl = async (url, opts) => { pedido = { url, opts }; return new Response(JSON.stringify({ ids: ['abc'] }), { status: 201 }); };
  const r = await subirFacturaMeli({ token: 'TK', pack: '2000015853536563', pdf: pdfFalso(), nombre: 'eTicket A 414.pdf', fetchImpl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pedido.url, 'https://api.mercadolibre.com/packs/2000015853536563/fiscal_documents');
  assert.strictEqual(pedido.opts.method, 'POST');
  assert.strictEqual(pedido.opts.headers.Authorization, 'Bearer TK');
  const archivo = pedido.opts.body.get('fiscal_document');
  assert.strictEqual(archivo.type, 'application/pdf');
  assert.strictEqual(archivo.name, 'eTicket A 414.pdf');
  assert.strictEqual(Buffer.from(await archivo.arrayBuffer()).toString(), pdfFalso().toString());
});

// ── /api/meli/factura ────────────────────────────────────────────────────────
// Supabase falso con lo justo para el endpoint. `sinColumna` imita una base donde la migración
// de factura_meli_at no corrió.
function supabaseFalso(filas, { sinColumna = false } = {}) {
  return () => ({
    from() {
      const q = { filtros: [], update: null, single: false };
      const b = {
        select: () => b,
        eq: (c, v) => { q.filtros.push(r => r[c] === v); return b; },
        update: f => { q.update = f; return b; },
        single: () => { q.single = true; return b; },
        then: (ok, ko) => Promise.resolve((() => {
          if (q.update && sinColumna && 'factura_meli_at' in q.update) {
            return { data: null, error: { message: "Could not find the 'factura_meli_at' column of 'ventas' in the schema cache" } };
          }
          const sel = filas.filter(r => q.filtros.every(f => f(r)));
          if (q.update) sel.forEach(r => Object.assign(r, q.update));
          return { data: q.single ? (sel[0] || null) : sel, error: null };
        })()).then(ok, ko),
      };
      return b;
    },
  });
}

function respuesta() {
  const r = { statusCode: 200, cuerpo: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.statusCode = c; return r; };
  r.json = c => { r.cuerpo = c; return r; };
  r.end = () => r;
  return r;
}

const filasCarrito = () => [
  { id: 'L1', canal: 'meli', orden_meli: '1000000000000001', pack_id: '2000015851965481', facturada: null },
  { id: 'L2', canal: 'meli', orden_meli: '1000000000000002', pack_id: '2000015851965481', facturada: null },
  { id: 'OTRA', canal: 'meli', orden_meli: '2000019999999999', pack_id: null, facturada: null },
  { id: 'MOS', canal: 'mostrador', orden_meli: null, pack_id: null, facturada: null },
];

test('sube la factura y marca facturado el carrito entero, con la fecha de subida', async () => {
  const filas = filasCarrito();
  const pedidos = [];
  const h = handler({ getSupabaseImpl: supabaseFalso(filas), getTokenImpl: async () => 'TK',
    fetchImpl: async (url) => { pedidos.push(url); return new Response('{"ids":["x"]}', { status: 201 }); } });
  const res = respuesta();
  await h({ method: 'POST', body: { ventaId: 'L2', pdf: pdfFalso().toString('base64'), nombre: 'a.pdf' } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.cuerpo));
  assert.deepStrictEqual(pedidos, ['https://api.mercadolibre.com/packs/2000015851965481/fiscal_documents']);
  assert.deepStrictEqual(res.cuerpo.ventas.sort(), ['L1', 'L2']);
  assert.ok(filas[0].facturada && filas[0].factura_meli_at && filas[1].factura_meli_at);
  assert.strictEqual(filas[2].facturada, null, 'otra venta no se toca');
});

test('si MELI no acepta la factura, la venta no queda marcada y se ve el motivo', async () => {
  const filas = filasCarrito();
  const h = handler({ getSupabaseImpl: supabaseFalso(filas), getTokenImpl: async () => 'TK',
    fetchImpl: async () => new Response(JSON.stringify({ message: 'invalid_file', cause: [{ message: 'El documento ya fue cargado' }] }), { status: 400 }) });
  const res = respuesta();
  await h({ method: 'POST', body: { ventaId: 'OTRA', pdf: pdfFalso().toString('base64') } }, res);
  assert.strictEqual(res.statusCode, 502);
  assert.match(res.cuerpo.error, /MELI no aceptó la factura: invalid_file — El documento ya fue cargado/);
  assert.strictEqual(filas[2].facturada, null);
});

test('rechaza lo que no es una venta MELI o no es un PDF, sin llamar a MELI', async () => {
  const filas = filasCarrito();
  let llamadas = 0;
  const h = handler({ getSupabaseImpl: supabaseFalso(filas), getTokenImpl: async () => 'TK', fetchImpl: async () => { llamadas++; } });
  const casos = [
    [{ ventaId: 'MOS', pdf: pdfFalso().toString('base64') }, 400, /no es de Mercado Libre/],
    [{ ventaId: 'NO-EXISTE', pdf: pdfFalso().toString('base64') }, 404, /No encontré esa venta/],
    [{ ventaId: 'OTRA', pdf: Buffer.from('hola').toString('base64') }, 400, /no es un PDF/],
    [{ pdf: pdfFalso().toString('base64') }, 400, /Falta la venta/],
  ];
  for (const [body, status, msg] of casos) {
    const res = respuesta();
    await h({ method: 'POST', body }, res);
    assert.strictEqual(res.statusCode, status, JSON.stringify(body));
    assert.match(res.cuerpo.error, msg);
  }
  assert.strictEqual(llamadas, 0);
});

test('sin la migración de factura_meli_at la venta queda facturada igual y avisa', async () => {
  const filas = filasCarrito();
  const h = handler({ getSupabaseImpl: supabaseFalso(filas, { sinColumna: true }), getTokenImpl: async () => 'TK',
    fetchImpl: async () => new Response('{}', { status: 201 }) });
  const res = respuesta();
  await h({ method: 'POST', body: { ventaId: 'OTRA', pdf: pdfFalso().toString('base64') } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.cuerpo.migracionPendiente, true);
  assert.strictEqual(filas[2].facturada, true);
});
