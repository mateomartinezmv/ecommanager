// api/meli/_promosReglas.js
// Las reglas con las que se decide si una promoción de MELI conviene, sin red ni base:
// todo lo que entra son números y todo lo que sale es una decisión explicada.
//
// MELI propone descuentos pensando en su exposición, no en el margen del vendedor: en una
// misma tanda llegaron propuestas del 28%, 31%, 37% y 42%. Acá se cruzan con tres reglas
// del negocio:
//
//   1. Piso de margen bruto: lo que cobra el vendedor tiene que ser al menos 2 × costo
//      (margen bruto del 100%). Es bruto: antes de comisión, envío y Ads.
//   2. Tope absoluto: ningún descuento a cargo del vendedor pasa del 30%, ni para liquidar.
//   3. Cuánto se descuenta depende de cómo se vende el producto:
//        · se vende bien (el stock dura < 30 días)        → nada: se vende igual;
//        · se vende algo (1 o más ventas por semana)       → 15–20%;
//        · no se vende (menos de 1 venta por semana)       → 25–30%;
//        · discontinuado con stock                         → hasta 30%, para liquidar.
//
// Lo que cuenta es lo que pone el VENDEDOR. En las campañas cofondeadas MELI paga parte:
// un 35% donde MELI pone 15 es un 20% para el vendedor, y eso es lo que se compara con las
// reglas. Una promoción que paga MELI entera no le cuesta nada y siempre se acepta.

const PISO_MULTIPLO = 2;          // lo cobrado tiene que ser al menos 2 × costo
const TOPE_ABSOLUTO = 0.30;       // ningún descuento a cargo del vendedor por encima de esto
const MIN_DESCUENTO_MELI = 0.05;  // MELI no acepta un descuento individual de menos del 5%
const DIAS_BIEN = 30;             // stock para menos de esto: se vende solo
const MIN_VENTAS_ALGO = 8;        // en 60 días: una por semana. Menos es "no se vende"
const TOLERANCIA = 0.005;         // redondeos de MELI (28,4% contra un tope de 28%)

const SEGMENTOS = {
  bien:        { objetivo: 0,    tope: 0,    txt: 'Se vende bien' },
  algo:        { objetivo: 0.15, tope: 0.20, txt: 'Se vende algo' },
  quieto:      { objetivo: 0.25, tope: 0.30, txt: 'No se vende' },
  liquidar:    { objetivo: 0.30, tope: 0.30, txt: 'Discontinuado' },
  sin_stock:   { objetivo: 0,    tope: 0,    txt: 'Sin stock' },
  sin_costo:   { objetivo: 0,    tope: 0,    txt: 'Sin costo cargado' },
};

const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r1 = v => Math.round(v * 1000) / 10;   // fracción → % con un decimal

/**
 * En qué situación está el producto, a partir de su stock y de lo que vendió en 60 días.
 */
function segmento({ stock, vendidas60, discontinuado, costo }) {
  if (num(costo) <= 0) return 'sin_costo';
  if (num(stock) <= 0) return 'sin_stock';
  if (discontinuado) return 'liquidar';
  const v = num(vendidas60);
  if (v <= 0) return 'quieto';
  const dias = num(stock) / (v / 60);
  if (dias < DIAS_BIEN) return 'bien';
  // Menos de una venta por semana es "no se vende", aunque el stock dure poco porque es
  // poco: así lo ve el negocio (fat bars, pata de cabra). Con una o más por semana se vende
  // algo, aunque haya stock para meses (los soportes): 15–20%, no 30%.
  if (v < MIN_VENTAS_ALGO) return 'quieto';
  return 'algo';
}

function diasDeStock(stock, vendidas60) {
  const v = num(vendidas60);
  return v > 0 ? Math.round(num(stock) / (v / 60)) : null;
}

/**
 * El descuento máximo a cargo del vendedor para un precio de lista: el menor entre el tope
 * de su segmento, el tope absoluto y el que deja cobrar todavía 2 × costo.
 */
function limites({ precioLista, costo, seg }) {
  const s = SEGMENTOS[seg] || SEGMENTOS.bien;
  const lista = num(precioLista);
  const piso = PISO_MULTIPLO * num(costo);
  const porPiso = lista > 0 ? Math.max(0, 1 - piso / lista) : 0;
  const maximo = Math.max(0, Math.min(s.tope, TOPE_ABSOLUTO, porPiso));
  return {
    objetivo: Math.min(s.objetivo, maximo),
    maximo,
    piso_precio: Math.round(piso),
    // Qué regla es la que aprieta: es lo que se le explica al vendedor.
    limita: maximo === 0 && s.tope > 0 ? 'piso'
      : porPiso < Math.min(s.tope, TOPE_ABSOLUTO) ? 'piso'
      : s.tope < TOPE_ABSOLUTO ? 'segmento' : 'tope',
  };
}

/**
 * Normaliza una promoción tal como la devuelve /seller-promotions/items/{id}?app_version=v2.
 * Cada tipo trae los números con nombres distintos: unas un precio fijo (`price`), otras un
 * rango donde el vendedor elige (`min_discounted_price`…`max_discounted_price`).
 */
//
// OJO con `price` en las candidatas con rango (LIGHTNING, DOD, PRICE_DISCOUNT): no es el
// precio de la oferta. En una relámpago llega un 3% de descuento cuando el rango que MELI
// acepta arranca en 10%; mandar ese precio es "Invalid request". Con rango, manda el
// sugerido (y si no hay, el tope del rango).
function normalizarPromo(p, precioItem) {
  const lista = num(p.original_price) || num(precioItem);
  const min = num(p.min_discounted_price) || null;
  const max = num(p.max_discounted_price) || null;
  const sugerido = num(p.suggested_discounted_price) || null;
  const conRango = !!(min || max);
  const precio = conRango ? (sugerido || max) : (num(p.price) || sugerido || null);
  const id = p.id || p.promotion_id || null;
  return {
    id,
    // Las candidatas PRICE_DISCOUNT ("podés poner tu descuento") no traen id: la clave para
    // encontrarlas de nuevo es el tipo, que en una publicación no se repite.
    clave: id || p.type || null,
    tipo: p.type || null,
    nombre: p.name || null,
    estado: p.status || null,
    inicio: p.start_date || null,
    fin: p.finish_date || null,
    lista,
    precio,
    min, max, sugerido,
    meli_pct: num(p.meli_percentage) / 100,
    seller_pct: p.seller_percentage !== undefined && p.seller_percentage !== null ? num(p.seller_percentage) / 100 : null,
    offer_id: p.offer_id || p.ref_id || null,
    // Las relámpago piden cuántas unidades van a la oferta. MELI no documenta igual el nombre
    // en todos los tipos: se toma el que venga.
    stock_min: num(p.min_stock ?? p.stock?.min ?? p.min_quantity) || null,
    stock_max: num(p.max_stock ?? p.stock?.max ?? p.max_quantity) || null,
    // Lo que mandó MELI tal cual, para diagnosticar tipos nuevos sin adivinar.
    crudo: p,
  };
}

/**
 * Qué parte del precio de lista pone el vendedor si entra a `precio`.
 */
function aporteVendedor(promo, precio) {
  const lista = num(promo.lista);
  if (lista <= 0 || !precio) return 0;
  const total = Math.max(0, 1 - precio / lista);
  if (promo.seller_pct !== null && promo.seller_pct !== undefined && precio === promo.precio) {
    return Math.max(0, promo.seller_pct);
  }
  return Math.max(0, total - num(promo.meli_pct));
}

/**
 * La decisión sobre una promoción: aceptar como viene, entrar a otro precio dentro del
 * rango que MELI permite (contraoferta) o rechazar. Siempre con el motivo.
 */
function evaluarPromo(promo, { costo, seg, corriendo = false }) {
  const lim = limites({ precioLista: promo.lista, costo, seg });
  const s = SEGMENTOS[seg] || SEGMENTOS.bien;
  const base = { ...lim, segmento: seg };
  const total = promo.lista > 0 && promo.precio ? 1 - promo.precio / promo.lista : 0;
  const vendedor = aporteVendedor(promo, promo.precio);
  const out = (veredicto, motivo, extra = {}) => ({
    ...base,
    veredicto,
    motivo,
    total_pct: r1(total),
    vendedor_pct: r1(vendedor),
    meli_pct: r1(num(promo.meli_pct)),
    precio_final: promo.precio,
    ...extra,
  });

  // La paga MELI entera: no cuesta nada.
  if (vendedor <= TOLERANCIA && total > 0) {
    return out('aceptar', 'La paga Mercado Libre entera: a vos no te cuesta nada.', { deal_price: rangoAdmite(promo) ? promo.precio : null });
  }

  if (seg === 'sin_costo') return out('rechazar', 'El producto no tiene costo cargado en Stock: sin costo no se puede saber si conviene.');
  if (seg === 'sin_stock') return out('rechazar', 'Sin stock no tiene sentido entrar a una promoción.');
  if (seg === 'bien') return out('rechazar', `Se vende solo (stock para menos de ${DIAS_BIEN} días): el descuento sería plata regalada.`);

  if (vendedor <= lim.maximo + TOLERANCIA) {
    return out('aceptar', `Tu parte (${r1(vendedor)}%) está dentro de lo permitido (${r1(lim.maximo)}%).`, { deal_price: rangoAdmite(promo) ? promo.precio : null });
  }

  // MELI propone de más. Si la promoción deja elegir el precio dentro de un rango, se entra
  // con el descuento objetivo (o lo más cerca que el rango permita) sin pasar el máximo.
  // A una que ya está corriendo no se le contraoferta: está dentro de la regla o no.
  if (!corriendo && rangoAdmite(promo)) {
    const precioMaximoPermitido = promo.max || promo.lista;            // el descuento más chico que MELI acepta
    const precioMinimoPropio = Math.ceil(promo.lista * (1 - lim.maximo)); // el más barato que permiten las reglas
    const objetivo = Math.ceil(promo.lista * (1 - lim.objetivo));
    let precio = Math.min(objetivo, precioMaximoPermitido);
    if (promo.min) precio = Math.max(precio, promo.min);
    const contra = 1 - precio / promo.lista;
    if (contra >= MIN_DESCUENTO_MELI - TOLERANCIA && precio >= precioMinimoPropio && (!promo.max || precio <= promo.max)) {
      const v = aporteVendedor(promo, precio);
      return out('contraoferta',
        `MELI sugiere ${r1(total)}%; entrás con ${r1(1 - precio / promo.lista)}%, que es lo que permiten tus reglas.`,
        { deal_price: precio, contra_pct: r1(1 - precio / promo.lista), contra_vendedor_pct: r1(v) });
    }
  }

  const motivo = lim.limita === 'piso'
    ? `Tu parte sería ${r1(vendedor)}% y te dejaría cobrando menos de 2 × costo ($${lim.piso_precio}). Máximo: ${r1(lim.maximo)}%.`
    : `Tu parte sería ${r1(vendedor)}%; para "${s.txt}" el máximo es ${r1(lim.maximo)}%.`;
  return out('rechazar', motivo);
}

// Promociones donde el vendedor elige el precio dentro de un rango.
function rangoAdmite(promo) {
  return !!(promo.min || promo.max) || ['DEAL', 'SELLER_CAMPAIGN', 'PRICE_DISCOUNT'].includes(promo.tipo);
}

/**
 * El descuento propio (PRICE_DISCOUNT) que se puede poner sin esperar a MELI: el objetivo
 * del segmento, recortado por el piso. Null si no corresponde o si queda por debajo del
 * mínimo que MELI acepta.
 */
function descuentoPropio({ precioLista, costo, seg }) {
  const lim = limites({ precioLista, costo, seg });
  const pct = lim.objetivo;
  if (pct < MIN_DESCUENTO_MELI) return null;
  const precio = Math.ceil(num(precioLista) * (1 - pct));
  return { pct: r1(1 - precio / num(precioLista)), precio };
}

module.exports = {
  SEGMENTOS, PISO_MULTIPLO, TOPE_ABSOLUTO, MIN_DESCUENTO_MELI, DIAS_BIEN, MIN_VENTAS_ALGO,
  segmento, diasDeStock, limites, normalizarPromo, aporteVendedor, evaluarPromo, descuentoPropio,
};
