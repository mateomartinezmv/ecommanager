// api/meli/_adsCambios.js
// El "antes y después" de un cambio en Mercado Ads, como función pura para poder testearla
// sin base de datos.
//
// Compara las dos semanas anteriores al cambio contra las dos siguientes (el día del
// cambio cuenta como "después"). Si todavía no pasaron dos semanas, la ventana de después
// es más corta y las dos se comparan por día, no por total: si no, cualquier cambio
// reciente parecería haber bajado el gasto.

const VENTANA_DIAS = 14;

const r2 = v => Math.round(v * 100) / 100;
const num = v => parseFloat(v) || 0;
const aFecha = d => d.toISOString().slice(0, 10);
const sumarDias = (fecha, n) => aFecha(new Date(new Date(fecha + 'T00:00:00Z').getTime() + n * 86400000));

/**
 * @param {object} cambio      fila de meli_ads_cambios (fecha, nivel, campaign_id, ad_group_id)
 * @param {Array}  snapshot    filas de meli_ads_anuncios (fecha, campaign_id, ad_group_id, sku, spend, facturacion, unidades)
 * @param {Map}    contribPorSku  SKU en mayúsculas → contribución por unidad (lo que deja cada venta)
 * @param {string} hoy         YYYY-MM-DD
 */
function antesYDespues(cambio, snapshot, contribPorSku, hoy) {
  const f = String(cambio.fecha).slice(0, 10);
  const ayer = sumarDias(hoy, -1);   // hoy todavía no está consolidado en MELI
  const ventanas = {
    antes: { desde: sumarDias(f, -VENTANA_DIAS), hasta: sumarDias(f, -1) },
    despues: { desde: f, hasta: [sumarDias(f, VENTANA_DIAS - 1), ayer].sort()[0] },
  };
  const delCambio = (s) => cambio.nivel === 'anuncio'
    ? String(s.ad_group_id) === String(cambio.ad_group_id)
    : String(s.campaign_id) === String(cambio.campaign_id);

  const resumen = ({ desde, hasta }) => {
    const dias = hasta >= desde
      ? Math.round((new Date(hasta) - new Date(desde)) / 86400000) + 1 : 0;
    const t = { desde, hasta, dias, inversion: 0, facturacion: 0, unidades: 0, ganancia: 0, sin_costo: 0 };
    if (!dias) return t;
    for (const s of snapshot) {
      const fecha = String(s.fecha).slice(0, 10);
      if (fecha < desde || fecha > hasta || !delCambio(s)) continue;
      const inv = num(s.spend), u = parseInt(s.unidades, 10) || 0;
      t.inversion += inv;
      t.facturacion += num(s.facturacion);
      t.unidades += u;
      const c = s.sku ? contribPorSku.get(String(s.sku).toUpperCase()) : undefined;
      if (c === undefined) t.sin_costo += inv;
      t.ganancia += (c || 0) * u - inv;
    }
    t.roas = t.inversion > 0 ? r2(t.facturacion / t.inversion) : null;
    t.inversion_dia = r2(t.inversion / dias);
    t.ganancia_dia = r2(t.ganancia / dias);
    t.unidades_dia = r2(t.unidades / dias);
    for (const k of ['inversion', 'facturacion', 'ganancia', 'sin_costo']) t[k] = r2(t[k]);
    return t;
  };

  const antes = resumen(ventanas.antes);
  const despues = resumen(ventanas.despues);

  // El veredicto mira la ganancia por día: es lo único que importa del cambio. Con menos
  // de 7 días de después todavía no dice nada.
  let veredicto = 'esperando';
  if (despues.dias >= 7 && (antes.inversion > 0 || despues.inversion > 0)) {
    const d = despues.ganancia_dia - antes.ganancia_dia;
    const escala = Math.max(Math.abs(antes.ganancia_dia), 1);
    veredicto = d > escala * 0.1 ? 'mejoro' : d < -escala * 0.1 ? 'empeoro' : 'igual';
  }
  return { antes, despues, veredicto };
}

module.exports = { antesYDespues, VENTANA_DIAS, sumarDias };
