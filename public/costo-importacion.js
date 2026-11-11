// public/costo-importacion.js
// Lo que cuesta de verdad una importación, cómo se paga y cómo cambia el costo de cada
// producto cuando llega. Sólo reglas, sin pantalla: la usan importaciones.html y
// api/importaciones.js (vía require), y los tests la cargan directo.
//
// Cómo se importa desde noviembre 2026 (importador GrupoRAS):
//   · Costo en China      → lo que se le paga a la fábrica: Σ cantidad × costo unitario (USD).
//   · Puesta en puerto    → la cotización del importador: FOB + flete hasta el puerto de
//                           Montevideo, todo pago. Incluye el costo en China.
//   · Nacionalización     → importación, manejo y nacionalización de la mercadería.
//   · Traslado interno    → del puerto al depósito, si se paga aparte.
//   Ninguno lleva IVA: el costo total es la suma, y ése es el costo real.
//
//   factor = costo total ÷ costo en China (≈ 1,35–1,40 con este esquema; con el anterior,
//   que pagaba IVA, se usaba 2,25). Cada producto carga el mismo factor: el flete y la
//   nacionalización se reparten en proporción a lo que costó en China.
//
// Pagos: 50% del costo en China al confirmar el pedido, el otro 50% cuando la mercadería está
// lista (7 a 10 días después) y, al llegar a puerto, el saldo: flete + nacionalización +
// traslado.
//
// Costo del producto por PPP (precio promedio ponderado): al llegar, el costo de cada SKU pasa
// a ser el promedio entre las unidades que ya había en depósito, a su costo anterior, y las que
// llegan, a su costo puesto en Uruguay en pesos. productos.costo es por unidad de depósito.
//
// Las importaciones cargadas antes de este esquema no tienen costo_puerto: su `total` es lo
// pagado con IVA y no se usa para el PPP.

(function (raiz) {
  const DIAS_SEGUNDO_PAGO = 10;      // "aproximadamente 7 a 10 días": se toma el peor caso
  const COTIZACION_DEFAULT = 40;     // UYU por USD con la que se armó la planilla de JBL
  const IMPORTADOR_DEFAULT = 'GrupoRAS';

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const r2 = n => Math.round(n * 100) / 100;
  const r4 = n => Math.round(n * 10000) / 10000;

  function sumarDias(iso, dias) {
    if (!iso) return null;
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d)) return null;
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  function qtyDe(it) { return num(it.qty ?? it.quantity_ordered); }
  function costoDe(it) { return num(it.costo ?? it.unit_cost); }

  function costoChina(items) {
    return r2((items || []).reduce((s, it) => s + qtyDe(it) * costoDe(it), 0));
  }

  // ¿La importación está cargada con el esquema de puesta en puerto (sin IVA)?
  function esPuerto(imp) {
    return imp != null && imp.costo_puerto != null && imp.costo_puerto !== '' && num(imp.costo_puerto) > 0;
  }

  // Totales de una importación. Con el esquema viejo sólo se informa lo que había.
  function totales(imp) {
    const china = costoChina(imp?.items);
    const nacional = num(imp?.nacional);
    const traslado = num(imp?.traslado);
    if (!esPuerto(imp)) {
      return { modelo: 'iva', costoChina: china, total: num(imp?.total), nacional, traslado,
        puerto: null, flete: null, factor: null };
    }
    const puerto = num(imp.costo_puerto);
    const total = r2(puerto + nacional + traslado);
    return {
      modelo: 'puerto',
      costoChina: china,
      puerto: r2(puerto),
      flete: r2(puerto - china),          // FOB + flete: lo que cobra el importador sobre China
      nacional: r2(nacional),
      traslado: r2(traslado),
      total,
      factor: china > 0 ? r4(total / china) : null,
    };
  }

  function cotizacionDe(imp) {
    const c = num(imp?.cotizacion_usd);
    return c > 0 ? c : COTIZACION_DEFAULT;
  }

  // Costo de cada renglón puesto en Uruguay: costo en China × factor, en USD y en pesos.
  function costosUnitarios(imp) {
    const t = totales(imp);
    const cotiz = cotizacionDe(imp);
    return (imp?.items || []).map(it => {
      const cn = costoDe(it);
      const usd = t.factor ? cn * t.factor : null;
      return {
        sku: String(it.sku || '').trim(),
        nombre: it.nombre || it.product_name || '',
        qty: qtyDe(it),
        costoChina: cn,
        costoUsd: usd == null ? null : r4(usd),
        costoUyu: usd == null ? null : r2(usd * cotiz),
      };
    });
  }

  // Los tres pagos. Los montos salen siempre de los costos; de `previos` se conserva lo que el
  // usuario marcó (pagado, fecha de pago) y las fechas estimadas que haya cambiado.
  function armarPagos(imp, previos) {
    const t = totales(imp);
    const mitad = r2(t.costoChina / 2);
    const segunda = r2(t.costoChina - mitad);
    const saldo = r2(Math.max(0, t.total - t.costoChina));
    const base = [
      { id: 'anticipo', concepto: '50% del costo al proveedor', a: 'proveedor', monto: mitad,
        estimado: imp?.fecha || null },
      { id: 'saldo_proveedor', concepto: '50% restante, mercadería lista', a: 'proveedor', monto: segunda,
        estimado: sumarDias(imp?.fecha, DIAS_SEGUNDO_PAGO) },
      { id: 'puerto', concepto: 'Saldo al llegar a puerto (flete + nacionalización)', a: 'importador', monto: saldo,
        estimado: imp?.llegada || null },
    ];
    const porId = {};
    (Array.isArray(previos) ? previos : []).forEach(p => { if (p && p.id) porId[p.id] = p; });
    return base.map(p => {
      const prev = porId[p.id] || {};
      return {
        ...p,
        estimado: prev.estimado_manual ? prev.estimado : p.estimado,
        estimado_manual: !!prev.estimado_manual,
        pagado: !!prev.pagado,
        fecha_pago: prev.pagado ? (prev.fecha_pago || null) : null,
      };
    });
  }

  function resumenPagos(pagos) {
    const lista = Array.isArray(pagos) ? pagos : [];
    const pagado = r2(lista.filter(p => p.pagado).reduce((s, p) => s + num(p.monto), 0));
    const pendiente = r2(lista.filter(p => !p.pagado).reduce((s, p) => s + num(p.monto), 0));
    const proximo = lista.find(p => !p.pagado) || null;
    return { pagado, pendiente, proximo, completos: lista.length > 0 && !proximo };
  }

  // PPP de un SKU: (stock × costo anterior + llegan × costo nuevo) ÷ (stock + llegan).
  // Sin stock previo, o sin costo previo cargado, el costo pasa a ser el de la importación.
  function ppp(stockAntes, costoAntes, qty, costoNuevo) {
    const s = Math.max(0, num(stockAntes));
    const c = num(costoAntes);
    const q = num(qty);
    const n = num(costoNuevo);
    if (q <= 0) return r2(c);
    if (s <= 0 || c <= 0) return r2(n);
    return r2((s * c + q * n) / (s + q));
  }

  // Plan del PPP de una importación contra los productos tal como están ANTES de sumar el
  // stock. Un SKU repetido en varios renglones se junta con su costo promedio.
  function planPPP(imp, productos) {
    if (!esPuerto(imp)) return { aplica: false, motivo: 'La importación no tiene la cotización puesta en puerto.', cambios: [], sinProducto: [] };
    const porSku = {};
    for (const u of costosUnitarios(imp)) {
      if (!u.sku || u.qty <= 0 || u.costoUyu == null) continue;
      const a = porSku[u.sku] = porSku[u.sku] || { qty: 0, valor: 0 };
      a.qty += u.qty;
      a.valor += u.qty * u.costoUyu;
    }
    const prods = {};
    (productos || []).forEach(p => { prods[p.sku] = p; });
    const cambios = [];
    const sinProducto = [];
    for (const sku of Object.keys(porSku)) {
      const p = prods[sku];
      if (!p) { sinProducto.push(sku); continue; }
      const { qty, valor } = porSku[sku];
      const costoImport = r2(valor / qty);
      const stockAntes = Math.max(0, num(p.stock_dep));
      const costoAntes = num(p.costo);
      cambios.push({
        sku, qty, stockAntes, costoAntes, costoImport,
        costoNuevo: ppp(stockAntes, costoAntes, qty, costoImport),
      });
    }
    return { aplica: true, cambios, sinProducto };
  }

  const CostoImportacion = {
    DIAS_SEGUNDO_PAGO, COTIZACION_DEFAULT, IMPORTADOR_DEFAULT,
    costoChina, esPuerto, totales, cotizacionDe, costosUnitarios, armarPagos, resumenPagos, ppp, planPPP, sumarDias,
  };
  raiz.CostoImportacion = CostoImportacion;
  if (typeof module !== 'undefined' && module.exports) module.exports = CostoImportacion;
})(typeof window !== 'undefined' ? window : globalThis);
