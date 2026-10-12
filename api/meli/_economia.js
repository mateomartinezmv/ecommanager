// api/meli/_economia.js
// La economía real de cada SKU, leída de lo que ya pasó en vez de supuestos.
//
// El ROAS de equilibrio de un anuncio es 1 / margen de contribución: por debajo de ese
// ROAS, cada venta que trae el anuncio deja menos plata de la que costó traerla. Hasta acá
// ese margen se armaba con dos simplificaciones que lo inflaban:
//
//   · una comisión fija del 15%, cuando la comisión efectiva de MELI no es pareja entre
//     categorías ni entre publicaciones (medida sobre las ventas reales da 14,3%);
//   · sin envío, cuando el envío lo paga el vendedor en casi todas las ventas y pesa
//     entre 5 y 12 puntos del precio.
//
// Un margen inflado baja el ROAS de equilibrio, y un ROAS de equilibrio bajo pinta de verde
// anuncios que están perdiendo plata. Este módulo arma el margen con la plata que de verdad
// se movió: la comisión que MELI cobró en cada venta y el costo del envío que se despachó
// por esa venta.
//
// Sobre los envíos sin costo cargado: los despachos de `mercado_envios` entran al CRM con
// costo 0 porque el número lo liquida MELI aparte, no porque el envío sea gratis. Tomarlos
// como 0 vuelve a inflar el margen, así que por defecto se completan con el promedio de los
// envíos que sí tienen costo (`envio: 'auto'`). Se puede forzar un número o apagarlo con
// `envio: 0`, y la respuesta siempre dice cuántos envíos se estimaron para que el número no
// se lea como medido.

const DIAS_VENTANA = 180;        // Historia que se mira para promediar comisión y envío.
const MIN_VENTAS_SKU = 3;        // Debajo de esto, el promedio del SKU es ruido: va el global.
const COMISION_DEFAULT = 15;     // Último recurso: catálogo sin una sola venta todavía.

const num = v => (v === null || v === undefined ? 0 : parseFloat(v) || 0);
const r2 = v => Math.round(v * 100) / 100;
const normSku = s => String(s || '').trim().toUpperCase();

const aFecha = d => d.toISOString().slice(0, 10);
const diasAtras = n => aFecha(new Date(Date.now() - n * 86400000));

/**
 * Reparte el costo de cada envío entre las ventas que cubre.
 *
 * Un envío puede tapar varias ventas: cuando el comprador arma un carrito, MELI manda un
 * solo paquete con un `pack_id` y el CRM guarda una venta por producto. Cobrarle el envío
 * entero a cada línea contaría el mismo gasto dos y tres veces, así que se prorratea por
 * unidades.
 *
 * Devuelve Map<venta_id, { costo, estimado }>.
 */
function repartirEnvios(ventas, envios, envioFallback) {
  const porVentaId = new Map();
  const porPackId = new Map();
  for (const e of envios) {
    if (e.venta_id) porVentaId.set(String(e.venta_id), e);
    if (e.pack_id && !porPackId.has(String(e.pack_id))) porPackId.set(String(e.pack_id), e);
  }

  // Qué ventas cuelgan de cada envío, para poder dividir su costo entre todas.
  const ventasDeEnvio = new Map();   // envio.id -> [venta]
  const envioDeVenta = new Map();    // venta.id -> envio
  for (const v of ventas) {
    const e = porVentaId.get(String(v.id))
      || (v.pack_id ? porPackId.get(String(v.pack_id)) : null);
    if (!e) continue;
    envioDeVenta.set(String(v.id), e);
    const k = String(e.id);
    if (!ventasDeEnvio.has(k)) ventasDeEnvio.set(k, []);
    ventasDeEnvio.get(k).push(v);
  }

  const salida = new Map();
  for (const v of ventas) {
    const e = envioDeVenta.get(String(v.id));
    if (!e) { salida.set(String(v.id), { costo: 0, estimado: false, sin_envio: true }); continue; }

    const hermanas = ventasDeEnvio.get(String(e.id)) || [v];
    const unidadesEnvio = hermanas.reduce((a, x) => a + Math.max(1, num(x.cantidad)), 0) || 1;
    const parte = Math.max(1, num(v.cantidad)) / unidadesEnvio;

    const real = num(e.costo);
    const estimado = real <= 0 && envioFallback > 0;
    const costoEnvio = real > 0 ? real : (estimado ? envioFallback : 0);

    salida.set(String(v.id), { costo: costoEnvio * parte, estimado, sin_envio: false });
  }
  return salida;
}

/**
 * Lee ventas y envíos de MELI y arma la comisión efectiva y el envío por unidad de cada SKU.
 *
 * @param {object} supabase
 * @param {object} opts
 * @param {number} opts.dias    Ventana de historia (default 180).
 * @param {number|'auto'} opts.envio  Qué hacer con los envíos sin costo cargado.
 * @returns {Promise<object>} economía lista para consultar con `deSku`.
 */
async function cargarEconomia(supabase, opts = {}) {
  const dias = Math.max(30, parseInt(opts.dias, 10) || DIAS_VENTANA);
  const desde = diasAtras(dias);

  // El límite explícito no es decoración: PostgREST corta en 1000 filas por defecto y una
  // tanda truncada no da error, da un promedio equivocado sin avisar.
  const [{ data: ventasRaw, error: errV }, { data: enviosRaw, error: errE }] = await Promise.all([
    supabase.from('ventas')
      .select('id, sku, cantidad, total, comision, estado, canal, fecha, pack_id')
      .gte('fecha', desde)
      .limit(50000),
    supabase.from('envios').select('id, venta_id, pack_id, costo, transportista').limit(50000),
  ]);
  if (errV) throw errV;
  if (errE) throw errE;

  const ventas = (ventasRaw || []).filter(v =>
    /meli/i.test(v.canal || '') && (v.estado || '') !== 'cancelada' && v.sku
  );
  const envios = enviosRaw || [];

  // El promedio de los envíos que sí tienen costo cargado. Es el número con el que se
  // completan los que vienen en 0, y el que se reporta para poder discutirlo.
  const idsVenta = new Set(ventas.map(v => String(v.id)));
  const packsVenta = new Set(ventas.filter(v => v.pack_id).map(v => String(v.pack_id)));
  const enviosDelPeriodo = envios.filter(e =>
    (e.venta_id && idsVenta.has(String(e.venta_id))) ||
    (e.pack_id && packsVenta.has(String(e.pack_id)))
  );
  const conCosto = enviosDelPeriodo.filter(e => num(e.costo) > 0);
  const envioPromedioReal = conCosto.length
    ? conCosto.reduce((a, e) => a + num(e.costo), 0) / conCosto.length
    : 0;

  const pedido = opts.envio;
  const envioFallback = pedido === 0 || pedido === '0' ? 0
    : (pedido !== undefined && pedido !== null && pedido !== 'auto' && num(pedido) > 0)
      ? num(pedido)
      : envioPromedioReal;

  const repartido = repartirEnvios(ventas, enviosDelPeriodo, envioFallback);

  // ── Acumulado por SKU ────────────────────────────────────────────────────────────
  const porSku = new Map();
  const total = {
    facturacion: 0, comision: 0, envio: 0, unidades: 0,
    ventas: 0, envios_estimados: 0, envios_sin_envio: 0,
  };

  for (const v of ventas) {
    const sku = normSku(v.sku);
    const env = repartido.get(String(v.id)) || { costo: 0, estimado: false };
    const unidades = Math.max(1, num(v.cantidad));

    if (!porSku.has(sku)) {
      porSku.set(sku, {
        sku, facturacion: 0, comision: 0, envio: 0, unidades: 0, ventas: 0, envios_estimados: 0,
      });
    }
    const a = porSku.get(sku);
    a.facturacion += num(v.total);
    a.comision += num(v.comision);
    a.envio += env.costo;
    a.unidades += unidades;
    a.ventas += 1;
    if (env.estimado) a.envios_estimados += 1;

    total.facturacion += num(v.total);
    total.comision += num(v.comision);
    total.envio += env.costo;
    total.unidades += unidades;
    total.ventas += 1;
    if (env.estimado) total.envios_estimados += 1;
    if (env.sin_envio) total.envios_sin_envio += 1;
  }

  const globalComisionPct = total.facturacion > 0 ? (total.comision / total.facturacion) * 100 : COMISION_DEFAULT;
  const globalEnvioUnit = total.unidades > 0 ? total.envio / total.unidades : 0;

  for (const a of porSku.values()) {
    a.comision_pct = a.facturacion > 0 ? (a.comision / a.facturacion) * 100 : globalComisionPct;
    a.envio_unitario = a.unidades > 0 ? a.envio / a.unidades : globalEnvioUnit;
    a.confiable = a.ventas >= MIN_VENTAS_SKU;
  }

  return {
    porSku,
    periodo: { desde, hasta: aFecha(new Date()), dias },
    global: {
      comision_pct: r2(globalComisionPct),
      envio_unitario: r2(globalEnvioUnit),
      facturacion: r2(total.facturacion),
      unidades: total.unidades,
      ventas: total.ventas,
    },
    envios: {
      total: enviosDelPeriodo.length,
      con_costo: conCosto.length,
      sin_costo: enviosDelPeriodo.length - conCosto.length,
      promedio_real: r2(envioPromedioReal),
      // Lo que se usó para completar los que vinieron en 0. En 0 significa que no se
      // completó nada y el margen vuelve a estar sobrestimado.
      fallback_usado: r2(envioFallback),
      estimados: total.envios_estimados,
      ventas_sin_envio: total.envios_sin_envio,
    },
    // Para que el front pueda decir "esto no es el 15% de siempre" sin recalcular nada.
    comision_default: COMISION_DEFAULT,
  };
}

/**
 * La comisión y el envío que le corresponden a un SKU, con la cadena de respaldo explícita.
 * `fuente` dice de dónde salió cada número, que es lo que permite mostrar un `~` en pantalla
 * en vez de hacer pasar una estimación por una medición.
 */
function deSku(eco, sku) {
  const a = eco?.porSku?.get(normSku(sku));
  if (a && a.confiable) {
    return {
      comision_pct: r2(a.comision_pct),
      envio_unitario: r2(a.envio_unitario),
      fuente: 'sku',
      ventas_muestra: a.ventas,
    };
  }
  if (a) {
    // Hay ventas pero son pocas: la comisión del SKU ya es confiable (es un porcentaje que
    // MELI aplica parejo) pero el envío promedio con una o dos ventas se va al diablo.
    return {
      comision_pct: r2(a.comision_pct),
      envio_unitario: r2(eco.global.envio_unitario),
      fuente: 'mixto',
      ventas_muestra: a.ventas,
    };
  }
  return {
    comision_pct: r2(eco?.global?.comision_pct ?? COMISION_DEFAULT),
    envio_unitario: r2(eco?.global?.envio_unitario ?? 0),
    fuente: eco?.global?.ventas ? 'global' : 'default',
    ventas_muestra: 0,
  };
}

/**
 * La cuenta del anuncio: qué queda de cada venta y qué ROAS hace falta para no perder.
 * Devuelve siempre los componentes, no sólo el resultado, porque la tabla los muestra en el
 * tooltip y porque un margen negativo tiene que poder explicarse sin volver a calcularlo.
 */
function contribucionUnitaria({ precio, costo, comision_pct, envio_unitario }) {
  const p = num(precio);
  const comision = p * (num(comision_pct) / 100);
  const envio = num(envio_unitario);
  const contribucion = p - num(costo) - comision - envio;
  const margen = p > 0 ? contribucion / p : 0;
  return {
    comision: r2(comision),
    envio: r2(envio),
    contribucion: r2(contribucion),
    margen_pct: r2(margen * 100),
    // Por debajo de este ROAS el anuncio destruye plata. Sin margen positivo no existe:
    // ningún ROAS alcanza, y un número grande se leería como una meta alcanzable.
    roas_breakeven: margen > 0 ? r2(1 / margen) : null,
  };
}

module.exports = {
  cargarEconomia,
  deSku,
  contribucionUnitaria,
  COMISION_DEFAULT,
  DIAS_VENTANA,
};
