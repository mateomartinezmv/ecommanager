// public/gesta.js
// Facturación de las ventas de MELI con Gesta (gesta.uy). Sólo reglas, sin pantalla: la usa
// index.html (Ventas → 🧾 Excel Gesta y 📎 Subir facturas a MELI) y los tests la cargan directo.
//
// Cómo factura Gesta, medido importando a mano (4/11/2026):
//   · El Excel de importación tiene las 14 columnas de COLUMNAS, una fila por producto.
//   · FECHA tiene que ser una fecha de Excel: como texto Gesta la rechaza ("Tipo esperado:
//     DateTime").
//   · Las ventas de MELI van a consumidor final: TIPO DOCUMENTO y DOCUMENTO vacíos → eTicket.
//   · CÓDIGO PRODUCTO es el número que Gesta le dio al producto (productos.codigo_gesta), no
//     el SKU. Un producto sin código no está en Gesta (a propósito): su venta no sale.
//   · PRECIO UNITARIO es el que cobra MELI (ya con el descuento), sin DESCUENTO: así el total
//     del eTicket es el "monto total bruto" de la venta en MELI, al centésimo.
//   · Gesta agrupa en una factura las filas de la misma fecha y cliente, y con dos ventas de
//     consumidor final en el mismo archivo se cae ("Object reference not set to an instance of
//     an object"). Por eso va UN EXCEL POR VENTA. Un carrito de MELI (varios productos, una
//     venta) sí va en un solo archivo, con una fila por producto.
//   · ADENDA lleva "Venta Mercado Libre #<número>": es el número con el que MELI recibe la
//     factura (pack, o la orden si no hay carrito), y como sale impreso en el PDF del eTicket,
//     al subir los PDF el CRM reconoce solo a qué venta va cada uno.

(function (raiz) {
  'use strict';

  const COLUMNAS = ['TIPO', 'FECHA', 'TIPO DOCUMENTO', 'DOCUMENTO', 'MONEDA', 'FORMA DE PAGO',
    'VENCIMIENTO', 'CÓDIGO PRODUCTO', 'DETALLE PRODUCTO', 'DETALLE ADICIONAL', 'CANTIDAD',
    'PRECIO UNITARIO', 'DESCUENTO', 'ADENDA'];

  // Las ventas anteriores se facturaron a mano en Gesta, antes de que existiera esto: no se
  // ofrecen para no facturarlas dos veces. Se puede cambiar en la pantalla.
  const DESDE_DEFAULT = '2026-11-03';

  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

  // El número de la venta en MELI: el del carrito si hay, si no el de la orden.
  function refDeVenta(v) {
    return String(v.packId || v.ordenMeli || '').trim();
  }
  // Misma clave que ticketKey() de index.html para las ventas MELI.
  function claveDeVenta(v) {
    return v.packId ? 'P:' + v.packId : 'M:' + v.ordenMeli;
  }

  // 'YYYY-MM-DD' → número de serie de Excel (días desde 30/12/1899), sin pasar por la zona
  // horaria del navegador.
  function fechaSerialExcel(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function agruparVentasMeli(ventas) {
    const grupos = new Map();
    for (const v of ventas) {
      if (v.canal !== 'meli' || !refDeVenta(v)) continue;
      const clave = claveDeVenta(v);
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(v);
    }
    return [...grupos.entries()].map(([clave, lineas]) => {
      lineas.sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
      return { clave, ref: refDeVenta(lineas[0]), lineas };
    });
  }

  // Las ventas MELI que todavía no se facturaron en Gesta, listas para el Excel, y las que no
  // pueden salir con el motivo.
  function pendientesGesta(ventas, productos, { desde = DESDE_DEFAULT } = {}) {
    const porSku = new Map((productos || []).map(p => [p.sku, p]));
    const comprobantes = [];
    const excluidas = [];

    for (const g of agruparVentasMeli(ventas || [])) {
      const { lineas } = g;
      if (lineas.some(v => v.estado === 'cancelada')) continue;
      if (lineas.every(v => v.facturada === true)) continue;
      const fecha = lineas.map(v => v.fecha || '').sort()[0];
      if (!fecha || fecha < desde) continue;

      const total = r2(lineas.reduce((s, v) => s + (Number(v.total) || 0), 0));
      const base = { clave: g.clave, ref: g.ref, fecha, total, lineas, comprador: lineas[0].comprador || '' };

      const sinCodigo = lineas.filter(v => !(porSku.get(v.sku)?.codigoGesta > 0));
      if (sinCodigo.length) {
        excluidas.push({ ...base, motivo: 'Sin código de Gesta: ' + sinCodigo.map(v => `${v.producto} (${v.sku})`).join(', ') });
        continue;
      }

      const filas = lineas.map(v => ({
        codigo: porSku.get(v.sku).codigoGesta,
        detalle: v.producto,
        cantidad: Number(v.cantidad) || 0,
        precio: r2(v.precioUnit),
      }));
      const totalFilas = r2(filas.reduce((s, f) => s + f.cantidad * f.precio, 0));
      if (Math.abs(totalFilas - total) > 0.005) {
        excluidas.push({ ...base, motivo: `Las filas suman $${totalFilas} y la venta $${total}: revisala a mano.` });
        continue;
      }
      comprobantes.push({ ...base, filas, carrito: filas.length > 1 });
    }

    comprobantes.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.ref < b.ref ? -1 : 1));
    return { comprobantes, excluidas };
  }

  // Las filas del Excel de un comprobante (encabezado incluido). La FECHA va como número de
  // serie: quien arma el archivo le pone formato de fecha a la columna B (ver COL_FECHA).
  function filasExcel(c) {
    const filas = [COLUMNAS.slice()];
    for (const f of c.filas) {
      filas.push(['eTicket', fechaSerialExcel(c.fecha), null, null, 'UYU', 'Contado', null,
        f.codigo, f.detalle, null, f.cantidad, f.precio, null, `Venta Mercado Libre #${c.ref}`]);
    }
    return filas;
  }
  const COL_FECHA = 'B';

  function nombreArchivo(c) {
    return `gesta-${c.ref}.xlsx`;
  }

  // Cómo puede aparecer un monto impreso en el PDF: 1.373,00 / 1373,00 / 1,373.00 / 1373.00.
  function formatosMonto(n) {
    const [ent, dec] = r2(n).toFixed(2).split('.');
    const miles = (sep) => ent.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    return [...new Set([`${miles('.')},${dec}`, `${ent},${dec}`, `${miles(',')}.${dec}`, `${ent}.${dec}`])];
  }

  // A qué venta MELI corresponde el texto de un PDF de Gesta. Busca primero la adenda
  // ("Venta Mercado Libre #…") y si no, cualquier número largo que sea una venta del CRM.
  // Devuelve { clave, ref, lineas, total, totalEnPdf } o null.
  function ventaDePdf(texto, ventas) {
    const plano = String(texto || '').replace(/\s+/g, ' ');
    const grupos = agruparVentasMeli(ventas || []);
    const porRef = new Map();
    for (const g of grupos) {
      porRef.set(g.ref, g);
      for (const v of g.lineas) if (v.ordenMeli) porRef.set(String(v.ordenMeli), g);
    }
    const candidatos = [];
    const adenda = /Mercado\s*Libre\s*#?\s*([\d\s]{10,40})/gi;
    let m;
    while ((m = adenda.exec(plano))) candidatos.push(m[1].replace(/\s/g, ''));
    for (const n of plano.match(/\d{10,20}/g) || []) candidatos.push(n);

    for (const n of candidatos) {
      const g = porRef.get(n) || porRef.get(n.slice(0, 16));
      if (!g) continue;
      const total = r2(g.lineas.reduce((s, v) => s + (Number(v.total) || 0), 0));
      const totalEnPdf = formatosMonto(total).some(f => plano.includes(f));
      return { clave: g.clave, ref: g.ref, lineas: g.lineas, total, totalEnPdf };
    }
    return null;
  }

  const Gesta = { COLUMNAS, COL_FECHA, DESDE_DEFAULT, refDeVenta, claveDeVenta, fechaSerialExcel,
    pendientesGesta, filasExcel, nombreArchivo, formatosMonto, ventaDePdf };
  raiz.Gesta = Gesta;
  if (typeof module !== 'undefined' && module.exports) module.exports = Gesta;
})(typeof window !== 'undefined' ? window : globalThis);
