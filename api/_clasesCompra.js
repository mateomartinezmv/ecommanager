// api/_clasesCompra.js
// Clase de compra de cada producto: cuáles no pueden quedar nunca sin stock, cuáles se
// reponen siempre, cuáles conviene comprar poco y cuáles descatalogar. Sin red ni base:
// entra la economía del producto (la arma api/restock.js) y sale la clase, con el motivo.
//
// La idea del negocio: la plata para comprar es poca y tarda ~4 meses en volver (≈80 días de
// importación + lo que tarda en venderse). Así que no alcanza con mirar cuánto se vende:
// importa cuánto deja cada peso que se pone en stock. Dos números por producto, los dos
// DESPUÉS de comisión, envío que cobra MELI y publicidad (con IVA):
//
//   contrib_mes  = lo que deja por mes, vendiendo al ritmo que vende cuando tiene stock
//   retorno      = lo que deja por cada $100 de costo puesto (mercadería a costo)
//
// Con los números de agosto a noviembre de 2026: el baúl 45L deja ~$24.000/mes y $169 por
// cada $100; el espejo alerón grande ~$17.600 y $242. El gato elevador deja bien por mes
// (~$11.000) pero solo $56 por cada $100, porque cada unidad cuesta $1.170. Los señaleros
// finos dejan $19 por cada $100 aun sin publicidad: con un envío propio o un cambio, pierden.
//
// Clases, en el orden en que se evalúan:
//   descatalogar  sin ventas en mucho tiempo, o deja tan poco que ni sin publicidad vale la pena
//   nuevo         poca historia: lotes de prueba hasta tener datos
//   nunca         ⭐ los que más dejan, en total y por peso: nunca pueden quedar sin stock
//   siempre       se reponen con 3,5 meses de venta
//   poco          dejan poco (en total, por peso, o los Ads se llevan todo): lo justo
//   sin_datos     sin costo o sin ventas propias para medir
//
// La meta de cada clase es cuánta venta tiene que haber entre stock y lo que viene en camino
// (ver objetivoUnidades). El reparto es la guía de cuánto de cada compra va a cada clase.

const CLASES = ['nunca', 'siempre', 'nuevo', 'poco', 'descatalogar', 'sin_datos'];

// Días de colchón por encima del plazo de importación. Con ~82 días de plazo:
// nunca ≈ 137 días (~4,5 meses), siempre ≈ 107 (~3,5 meses), poco = solo el plazo.
const COLCHON_DIAS = { nunca: 55, siempre: 25, poco: 0 };

// Guía de reparto de cada compra, en %. Los "nunca" dejan más de la mitad de la
// contribución pero, como son baratos para lo que dejan, cubrirlos entero usa ~1/3 de la
// compra: con más, sobra stock de ellos.
const REPARTO = { nunca: 35, siempre: 45, poco: 5, nuevo: 15, descatalogar: 0, sin_datos: 0 };

const UMBRAL = {
  NUNCA_CONTRIB_MES: 4000,   // deja al menos esto por mes después de Ads…
  NUNCA_RETORNO: 100,        // …y al menos $100 por cada $100 de costo…
  NUNCA_MIN_VENDIDAS: 10,    // …con al menos 10 unidades vendidas (no un golpe de suerte)
  SIEMPRE_CONTRIB_MES: 1000,
  SIEMPRE_RETORNO: 50,
  DESCATALOGAR_RETORNO_SIN_ADS: 30, // menos que esto por cada $100 aun sin publicidad
  SIN_VENTAS_DIAS: 60,       // con stock hace más que esto y sin una venta: descatalogar
  NUEVO_DIAS_ACTIVOS: 30,    // menos días con stock que esto: todavía es nuevo
  NUEVO_MIN_VENDIDAS: 5,
  COBERTURA_LARGA_DIAS: 180, // con más stock que esto, avisar que no hace falta comprar
};

const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const plata = v => '$' + Math.round(num(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const entero = v => Math.round(num(v));
const unoDec = v => (Math.round(num(v) * 10) / 10).toString().replace('.', ',');
const vendidasTxt = v => `${unoDec(v)} vendida${unoDec(v) === '1' ? '' : 's'}`;
// Meta de la clase en meses de venta, con el plazo de importación de verdad.
const mesesMeta = (lead, clase) => unoDec((num(lead) + COLCHON_DIAS[clase]) / 30);

/**
 * Clase de un producto.
 * Entra: {
 *   vendidas        unidades de depósito vendidas en la ventana de demanda (netas de devoluciones)
 *   dias_activos    días con stock dentro de esa ventana (los que usa la velocidad)
 *   dias_publicado  días desde que se publicó (o se cargó); null si no se sabe
 *   ventana_dias    largo de la ventana de demanda
 *   stock           unidades de depósito
 *   costo           costo puesto por unidad de depósito
 *   ventas_mes      unidades de depósito por mes (velocidad × 30)
 *   econ_uds        unidades con economía medida (ventas propias, no de kits); 0 = sin dato
 *   contrib_ud      lo que deja cada unidad de depósito después de Ads
 *   contrib_ud_sin_ads  ídem antes de Ads
 *   ads_pct         publicidad (con IVA) sobre lo que factura en MELI, 0–1
 *   ads_estimado    true si ads_pct es el promedio de la cuenta y no el del producto
 *   en_camino       unidades pedidas que todavía no llegaron
 *   dias_desde_llegada  días desde la última importación recibida de este SKU; null si no hay
 *   lead_dias       plazo de importación (para decir la meta en meses); 82 si no viene
 * }
 * Sale: { clase, motivo, contrib_mes, retorno, retorno_sin_ads }.
 */
function clasificar(p) {
  const vendidas = num(p.vendidas);
  const stock = num(p.stock);
  const costo = num(p.costo);
  const ventasMes = num(p.ventas_mes);
  const diasPub = p.dias_publicado === null || p.dias_publicado === undefined ? null : num(p.dias_publicado);
  const ventana = num(p.ventana_dias) || 180;
  const lead = num(p.lead_dias) || 82;
  const tieneEcon = num(p.econ_uds) > 0 && costo > 0;
  const contribMes = tieneEcon ? num(p.contrib_ud) * ventasMes : null;
  const retorno = tieneEcon ? (num(p.contrib_ud) / costo) * 100 : null;
  const retornoSinAds = tieneEcon ? (num(p.contrib_ud_sin_ads) / costo) * 100 : null;
  const base = {
    contrib_mes: contribMes === null ? null : entero(contribMes),
    retorno: retorno === null ? null : entero(retorno),
    retorno_sin_ads: retornoSinAds === null ? null : entero(retornoSinAds),
  };
  const enCamino = num(p.en_camino);
  const sale = (clase, motivo) => ({
    ...base, clase,
    motivo: clase === 'descatalogar' && enCamino > 0
      ? `${motivo} Ojo: ya vienen ${entero(enCamino)} en camino; no pidas más.`
      : motivo,
  });

  // ── Sin ventas ─────────────────────────────────────────────────────────────
  // Lo que cuenta es cuánto tiempo estuvo a la venta CON stock: desde que se publicó o desde
  // la última llegada, lo que sea más reciente. Un producto publicado en marzo que recibió
  // stock hace 3 semanas todavía no tuvo tiempo de venderse.
  if (vendidas <= 0) {
    const diasLlegada = p.dias_desde_llegada === null || p.dias_desde_llegada === undefined ? null : num(p.dias_desde_llegada);
    if (stock <= 0) {
      if (enCamino > 0) {
        return sale('nuevo', `Sin stock ni ventas en la ventana: no hay cómo medir la demanda. Cuando lleguen los ${entero(enCamino)} en camino vas a tener datos.`);
      }
      if (diasPub !== null && diasPub < UMBRAL.SIN_VENTAS_DIAS) {
        return sale('nuevo', `Publicado hace ${entero(diasPub)} días, todavía sin stock ni ventas.`);
      }
      return sale('descatalogar', `Sin stock y sin ventas en ${diasPub === null ? ventana : Math.min(ventana, entero(diasPub))} días: si no lo vas a volver a traer, marcalo como descatalogado en Stock.`);
    }
    const diasConStock = Math.min(ventana, ...[diasPub, diasLlegada].filter(d => d !== null).map(entero));
    if (diasConStock < UMBRAL.SIN_VENTAS_DIAS) {
      return sale('nuevo', `Tiene stock hace ${diasConStock} días y todavía no vendió: esperá a tener datos antes de volver a comprar.`);
    }
    return sale('descatalogar', `Sin ventas en ${diasConStock} días con stock y tenés ${plata(stock * costo)} parados en ${stock} unidad${stock === 1 ? '' : 'es'}:`
      + ' liquidalo (kit, promo o mostrador) y no lo vuelvas a pedir.');
  }

  // ── Poca historia ─────────────────────────────────────────────────────────
  const diasActivos = num(p.dias_activos);
  const recienPublicado = diasPub === null || diasPub < UMBRAL.SIN_VENTAS_DIAS;
  if (diasActivos < UMBRAL.NUEVO_DIAS_ACTIVOS || (vendidas < UMBRAL.NUEVO_MIN_VENDIDAS && recienPublicado)) {
    return sale('nuevo', `Poca historia (${vendidasTxt(vendidas)} en ${entero(diasActivos)} días con stock): comprá lotes de prueba hasta confirmar.`
      + ` Pasa a ⭐ si deja más de ${plata(UMBRAL.NUNCA_CONTRIB_MES)} por mes y más de $${UMBRAL.NUNCA_RETORNO} por cada $100.`);
  }

  if (!tieneEcon) {
    return sale('sin_datos', costo > 0
      ? 'No hay ventas propias para medir cuánto deja (solo se vendió dentro de kits): reponelo según la velocidad.'
      : 'Sin costo cargado: no se puede medir cuánto deja. Cargalo en Stock.');
  }

  const coberturaDias = ventasMes > 0 ? (stock / ventasMes) * 30 : null;
  const notaCobertura = coberturaDias !== null && coberturaDias > UMBRAL.COBERTURA_LARGA_DIAS
    ? ` Ya tenés stock para ~${entero(coberturaDias / 30)} meses: no hace falta comprar ahora.`
    : '';
  const est = p.ads_estimado ? ', estimado con el promedio de la cuenta' : '';
  const adsTxt = `${entero(num(p.ads_pct) * 100)}% de lo que factura en MELI${est}`;

  // ── Deja tan poco que ni sin publicidad vale la pena ─────────────────────────
  if (retornoSinAds < UMBRAL.DESCATALOGAR_RETORNO_SIN_ADS) {
    const pierde = num(p.contrib_ud_sin_ads) <= 0;
    return sale('descatalogar', (pierde
      ? `Aun sin publicidad pierde ${plata(-num(p.contrib_ud_sin_ads))} por unidad`
      : `Aun sin publicidad deja solo $${base.retorno_sin_ads} por cada $100 de costo`)
      + ': con un envío propio o un cambio, pierde plata. No lo vuelvas a pedir y liquidá lo que queda, o subile bastante el precio.');
  }

  // ── Los Ads se llevan todo ─────────────────────────────────────────────────
  if (contribMes <= 0) {
    return sale('poco', `Sin publicidad dejaría $${base.retorno_sin_ads} por cada $100 de costo, pero los Ads (${adsTxt}) se llevan todo y pierde ${plata(-num(p.contrib_ud))} por unidad.`
      + ' Sacalo de Ads o subile el precio antes de volver a comprar.' + notaCobertura);
  }

  // ── Nunca sin stock ──────────────────────────────────────────────────────────
  if (contribMes >= UMBRAL.NUNCA_CONTRIB_MES && retorno >= UMBRAL.NUNCA_RETORNO && vendidas >= UMBRAL.NUNCA_MIN_VENDIDAS) {
    return sale('nunca', `Deja ~${plata(contribMes)} por mes después de Ads y $${base.retorno} por cada $100 de costo: de los que más dejan.`
      + ` Meta: ~${mesesMeta(lead, 'nunca')} meses de venta entre stock y en camino.` + notaCobertura);
  }

  // ── Con stock siempre ─────────────────────────────────────────────────────────
  if (contribMes >= UMBRAL.SIEMPRE_CONTRIB_MES && retorno >= UMBRAL.SIEMPRE_RETORNO) {
    return sale('siempre', `Deja ~${plata(contribMes)} por mes después de Ads y $${base.retorno} por cada $100 de costo.`
      + ` Meta: ~${mesesMeta(lead, 'siempre')} meses de venta entre stock y en camino.` + notaCobertura);
  }

  // ── Comprar poco ─────────────────────────────────────────────────────────────
  if (retorno < UMBRAL.SIEMPRE_RETORNO) {
    // Si sin publicidad pasaría la vara, el problema son los Ads, no el producto.
    if (retornoSinAds >= UMBRAL.SIEMPRE_RETORNO) {
      return sale('poco', `Sin publicidad dejaría $${base.retorno_sin_ads} por cada $100 de costo, pero los Ads (${adsTxt}) le dejan $${base.retorno}.`
        + ' Sacalo de Ads o pasalo a una campaña de ROAS alto; si comprás, solo lo justo para el plazo de importación.' + notaCobertura);
    }
    return sale('poco', `Deja $${base.retorno} por cada $100 de costo: inmoviliza mucha plata para lo que deja.`
      + ' Comprá solo lo justo para el plazo de importación, o subile el precio.' + notaCobertura);
  }
  return sale('poco', `Deja poco en total (~${plata(contribMes)} por mes, ${vendidasTxt(ventasMes)} por mes): alcanza con lo justo para el plazo de importación.` + notaCobertura);
}

/**
 * Cuántas unidades tiene que haber entre stock y en camino, según la clase.
 * `puntoPedido` es el del modelo de reposición (plazo + colchón estadístico): la clase nunca
 * baja la protección de los que se reponen, pero a los de "comprar poco" les saca el colchón.
 */
function objetivoUnidades(clase, { velocidad, leadDias, puntoPedido }) {
  const v = num(velocidad);
  const pp = num(puntoPedido);
  if (clase === 'descatalogar') return 0;
  if (clase === 'nunca' || clase === 'siempre') return Math.max(pp, v * (num(leadDias) + COLCHON_DIAS[clase]));
  if (clase === 'poco') return v * num(leadDias);
  return pp;
}

/** Totales por clase para el resumen de la pantalla. Entra la lista de productos de restock. */
function resumenClases(productos) {
  const out = {};
  for (const c of CLASES) out[c] = { productos: 0, contrib_mes: 0, compra_mes: 0, valor_stock: 0, reparto_pct: REPARTO[c] };
  for (const p of productos || []) {
    const r = out[p.clase];
    if (!r) continue;
    r.productos += 1;
    r.contrib_mes += Math.max(0, num(p.contrib_mes));
    r.compra_mes += num(p.compra_mes);
    r.valor_stock += num(p.valor_stock);
  }
  const totContrib = CLASES.reduce((s, c) => s + out[c].contrib_mes, 0);
  const totCompra = CLASES.reduce((s, c) => s + out[c].compra_mes, 0);
  for (const c of CLASES) {
    const r = out[c];
    r.contrib_pct = totContrib > 0 ? entero((r.contrib_mes / totContrib) * 100) : 0;
    r.compra_pct = totCompra > 0 ? entero((r.compra_mes / totCompra) * 100) : 0;
    r.contrib_mes = entero(r.contrib_mes);
    r.compra_mes = entero(r.compra_mes);
    r.valor_stock = entero(r.valor_stock);
  }
  return out;
}

module.exports = { CLASES, COLCHON_DIAS, REPARTO, UMBRAL, clasificar, objetivoUnidades, resumenClases };
