// api/meli/_adsIva.js
// El IVA que MELI le suma a la publicidad.
//
// La API de Mercado Ads informa el gasto (`cost`) SIN IVA, y es la cifra que muestra el
// panel de Ads. Pero en la factura mensual ("Cargos por publicidad") MELI le suma el IVA
// básico de Uruguay, 22%: octubre 2026 dio $33.297 de gasto en la API y $41.024,66 en la
// factura (33.297 × 1,22 = 40.622; la diferencia es el corte del período de facturación).
//
// Como la cuenta está en IVA mínimo, ese IVA no se descuenta como crédito fiscal: es costo.
// Así que en todo lo que sea plata (gasto, ganancia, déficit) va el gasto con IVA.
//
// El ROAS y el ACOS se siguen midiendo como los mide MELI (sobre el gasto sin IVA), porque
// son los números de su panel y con los que se configura el ROAS objetivo de una campaña.
// Lo que cambia es el equilibrio: si cada $1 de gasto en MELI cuesta $1,22, hace falta un
// ROAS 22% más alto para no perder plata.

const IVA_ADS = 0.22;
const FACTOR_IVA_ADS = 1 + IVA_ADS;

const r2 = v => Math.round(v * 100) / 100;

/** Gasto de MELI (sin IVA) → lo que de verdad sale de la cuenta. */
const conIvaAds = v => r2((parseFloat(v) || 0) * FACTOR_IVA_ADS);

module.exports = { IVA_ADS, FACTOR_IVA_ADS, conIvaAds };
