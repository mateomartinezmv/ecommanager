// api/meli/_adsRoasPlan.js
// En qué campaña de ROAS objetivo va cada producto que se anuncia. Sin red ni base: entra la
// economía del producto y sale el destino, con el motivo.
//
// La idea del negocio: no todos los productos aguantan el mismo ROAS objetivo. Los que dejan
// mucho margen (espejos alerón, ~54%) pueden ir en la campaña de siempre a 4x; los que dejan
// menos (espejos de puño, ~38%) en 4x pierden plata en cada venta que trae el anuncio, y
// tienen que ir a una campaña más exigente (5x, 6x) donde MELI puja menos por ellos.
//
// La cuenta: en una venta que trae el anuncio, después de pagar la publicidad (con IVA)
// tiene que quedar al menos un `colchon` % del precio. El resto del margen es lo que se puede
// gastar en Ads:
//
//     margen − colchón  = lo que se puede gastar en Ads por cada $ vendido, con IVA
//     ROAS necesario    = 1,22 / (margen − colchón)        (ROAS de MELI, sin IVA)
//
// Con 15% de colchón: margen 54% → 3,1x (va en 4x) · 41% → 4,7x (5x) · 38% → 5,3x (6x).
// Se redondea hacia arriba al escalón de campaña más cercano. Si hace falta más que el
// escalón más alto, el producto no se sostiene con Ads: hay que subirle el precio.
//
// Dos casos no dependen del margen:
//   · Sin stock: no hay nada que anunciar.
//   · Se vende solo y se está por agotar: pagar Ads para vender más rápido algo que se va a
//     terminar igual es plata perdida. Se pausa hasta reponer.
//
// La pantalla (public/index.html, sección "Campañas por ROAS objetivo") repite esta misma
// cuenta para poder mover el colchón sin volver a pedirle todo a MELI: si se cambia acá,
// cambiarla allá.

const { FACTOR_IVA_ADS } = require('./_adsIva');

const ESCALONES = [4, 5, 6, 8];
const COLCHON_DEFAULT = 15;     // % del precio que queda después de Ads en una venta por anuncio
const DIAS_STOCK_CORTO = 15;    // con menos stock que esto…
const VENTAS_MES_SALIDA = 8;    // …y ≥ 2 ventas por semana, se pausa hasta reponer

const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = v => Math.round(v * 100) / 100;

/** ROAS de MELI (sin IVA) que deja `colchon` % del precio después de Ads. Null si no alcanza. */
function roasNecesario(margenPct, colchonPct = COLCHON_DEFAULT) {
  const libre = (num(margenPct) - num(colchonPct)) / 100;
  return libre > 0 ? r2(FACTOR_IVA_ADS / libre) : null;
}

/** El escalón de ROAS de una campaña a partir de su ACOS objetivo (MELI la guarda así). */
function roasDeCampana(acosTarget) {
  const a = num(acosTarget);
  return a > 0 ? r2(100 / a) : null;
}

/**
 * Destino de un producto.
 * Entra: { margen (%), stock (publicado), stock_dep, unidades_mes }.
 * Sale:  { destino: 4|5|6|8|'pausar'|'no_anunciar'|'sin_stock', roas_necesario, dias_stock, motivo }.
 */
function destinoRoas(p, { colchon = COLCHON_DEFAULT, escalones = ESCALONES } = {}) {
  const margen = num(p.margen);
  const stockDep = num(p.stock_dep);
  const stock = Math.max(num(p.stock), stockDep);
  const porMes = num(p.unidades_mes);
  const dias = porMes > 0 ? Math.round(stockDep / (porMes / 30)) : null;
  const nec = roasNecesario(margen, colchon);
  const base = { roas_necesario: nec, dias_stock: dias };

  if (stock <= 0) {
    return { ...base, destino: 'sin_stock', motivo: 'Sin stock: no hay nada que anunciar hasta reponer.' };
  }
  if (dias !== null && dias < DIAS_STOCK_CORTO && porMes >= VENTAS_MES_SALIDA) {
    return {
      ...base, destino: 'pausar',
      motivo: `Se vende solo (${Math.round(porMes)} por mes) y el stock alcanza para ~${dias} días:`
        + ' pagar Ads para que se agote antes no suma. Pausalo hasta reponer.',
    };
  }
  if (nec === null) {
    return {
      ...base, destino: 'no_anunciar',
      motivo: `Con ${r2(margen)}% de margen no queda el ${colchon}% después de pagar Ads: subí el precio antes de anunciarlo.`,
    };
  }
  const escalon = [...escalones].sort((a, b) => a - b).find(e => e >= nec - 0.005);
  if (!escalon) {
    return {
      ...base, destino: 'no_anunciar',
      motivo: `Necesitaría ROAS ${nec}x para dejar el ${colchon}%: más que la campaña más exigente (${Math.max(...escalones)}x).`
        + ' Subí el precio o sacalo de Ads.',
    };
  }
  return {
    ...base, destino: escalon,
    motivo: `Con ${r2(margen)}% de margen, para que quede el ${colchon}% después de Ads hace falta ROAS ${nec}x: va en la de ${escalon}x.`,
  };
}

module.exports = { ESCALONES, COLCHON_DEFAULT, DIAS_STOCK_CORTO, VENTAS_MES_SALIDA, roasNecesario, roasDeCampana, destinoRoas };
