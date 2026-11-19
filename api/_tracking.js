// api/_tracking.js
// Reglas del tracking de contenedores que pasan por la base: qué se guarda, cómo se mezcla lo
// que informa la naviera y cómo se mueven las importaciones que viajan adentro. Lo usan
// api/tracking.js (la pantalla) y api/cron/tracking.js (la consulta cada 4 horas).
//
// Las importaciones del contenedor quedan atadas a él:
//   · su `llegada` pasa a ser el arribo estimado del contenedor (lo que usan 📅 Reposición y
//     las respuestas de MELI de "vuelve pronto"), y con puesta en puerto se corre también la
//     fecha estimada del pago al importador;
//   · cuando el contenedor zarpa pasan a "en tránsito" y cuando llega al puerto, a "en aduana".
// Nunca se marcan como llegadas: eso suma stock y se hace a mano al recibir la mercadería.

const T = require('../public/tracking-contenedores');
const Costo = require('../public/costo-importacion');
const { consultarPIL } = require('./_pil');
const { esc } = require('./_telegram');

const MIGRACION = '20261118000000_add_trackings.sql';
const MSG_MIGRACION = `Falta correr la migración supabase/migrations/${MIGRACION} en Supabase.`;
const ESTADOS_IDS = T.ESTADOS.map(e => e.id);
// Etapas que se avisan por Telegram (además de los cambios del arribo).
const ESTADOS_AVISADOS = ['navegando', 'transbordo', 'en_puerto', 'retirado'];

function faltaMigracionTracking(error) {
  if (!error) return false;
  if (['PGRST205', '42P01'].includes(error.code)) return true;
  const msg = String(error.message || '');
  return /trackings/i.test(msg) && /relation|table|tabla|schema|exist/i.test(msg);
}

const texto = v => { const s = String(v ?? '').trim(); return s || null; };
const fecha = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);

// Un link pegado a mano siempre sale como http(s): nada de javascript: en un href.
function link(v) {
  const s = texto(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : 'https://' + s.replace(/^[a-z]+:\/*/i, '');
}

// [{ id, pi, descripcion, llegada_calculada }] sin repetidos. Acepta también ids sueltos.
function normalizarVinculos(lista) {
  const vistos = new Set();
  const out = [];
  for (const v of Array.isArray(lista) ? lista : []) {
    const o = typeof v === 'string' ? { id: v } : v;
    const id = texto(o?.id);
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    out.push({
      id,
      pi: texto(o.pi) ? String(o.pi).replace(/^\s*PI\s*[.#:-]?\s*/i, '').trim() : null,
      descripcion: texto(o.descripcion),
      llegada_calculada: fecha(o.llegada_calculada),
    });
  }
  return out;
}

// La fila a escribir a partir del body. `parcial` es para el PUT: lo que no viene no se toca.
function normalizarTracking(body, { parcial = false } = {}) {
  const b = body || {};
  const f = {};
  const viene = c => !parcial || b[c] !== undefined;
  if (viene('naviera')) f.naviera = T.naviera(b.naviera).id;
  if (viene('contenedor')) f.contenedor = T.normalizarContenedor(b.contenedor);
  if (viene('link_seguimiento')) f.link_seguimiento = link(b.link_seguimiento);
  for (const c of ['buque', 'viaje', 'puerto_origen', 'notas']) if (viene(c)) f[c] = texto(b[c]);
  if (viene('puerto_destino')) f.puerto_destino = texto(b.puerto_destino) || (parcial ? null : 'MONTEVIDEO');
  for (const c of ['etd', 'eta']) if (viene(c)) f[c] = fecha(b[c]);
  if (viene('estado')) f.estado = ESTADOS_IDS.includes(b.estado) ? b.estado : 'reservado';
  if (viene('importaciones')) f.importaciones = normalizarVinculos(b.importaciones);
  return f;
}

// A cada PI nueva en el contenedor se le guarda la llegada que tenía calculada, antes de que
// pase a ser el arribo del contenedor. La de las que ya estaban no se toca.
async function completarLlegadasCalculadas(supabase, vinculos, previos) {
  const prev = {};
  (Array.isArray(previos) ? previos : []).forEach(v => { if (v?.id) prev[v.id] = v; });
  const faltan = vinculos.filter(v => !v.llegada_calculada && !prev[v.id]?.llegada_calculada).map(v => v.id);
  const llegadas = {};
  if (faltan.length) {
    const { data, error } = await supabase.from('importaciones').select('id, llegada').in('id', faltan);
    if (error) throw error;
    (data || []).forEach(i => { llegadas[i.id] = i.llegada || null; });
  }
  return vinculos.map(v => ({
    ...v,
    llegada_calculada: prev[v.id]?.llegada_calculada || v.llegada_calculada || llegadas[v.id] || null,
  }));
}

// Suma el arribo nuevo al historial sólo si cambió.
function historialEta(tracking, eta, fuente, ahora) {
  const hist = Array.isArray(tracking?.eta_historial) ? tracking.eta_historial : [];
  const ultima = hist[hist.length - 1];
  if (!eta || (ultima && ultima.eta === eta)) return {};
  return { eta_historial: [...hist, { eta, desde: ahora, fuente }] };
}

// Mezcla lo que devolvió la naviera ({ tramos, eventos }) con el tracking guardado.
// Devuelve los campos a escribir y qué cambió (para avisar).
function aplicarConsulta(tracking, datos, { fuente = 'PIL', ahora = new Date().toISOString() } = {}) {
  const d = T.derivarDeEventos(datos?.eventos, datos?.tramos);
  const cambios = {
    tramos: datos?.tramos || [],
    eventos: datos?.eventos || [],
    estado: d.estado,
    consultado_at: ahora,
    consulta_error: null,
  };
  for (const c of ['etd', 'eta', 'buque', 'viaje', 'puerto_origen', 'puerto_destino']) if (d[c]) cambios[c] = d[c];
  const etaNueva = cambios.eta || tracking?.eta || null;
  Object.assign(cambios, historialEta(tracking, etaNueva, fuente, ahora));
  const etaAntes = tracking?.eta || null;
  const estadoAntes = tracking?.estado || 'reservado';
  return {
    cambios,
    derivado: d,
    novedades: {
      etaAntes, etaNueva,
      cambioEta: !!etaAntes && !!etaNueva && etaAntes !== etaNueva,
      estadoAntes, estadoNuevo: cambios.estado,
      cambioEstado: estadoAntes !== cambios.estado,
    },
  };
}

// Consulta la naviera (si se consulta sola) y guarda el resultado. Si la consulta falla, se
// guarda el error y queda lo último que se sabía.
async function actualizarDesdeNaviera(supabase, tracking, { consultar = consultarPIL, ahora = new Date().toISOString() } = {}) {
  if (!T.navieraAutomatica(tracking.naviera)) return { tracking, novedades: null, error: null, automatica: false };
  let cambios;
  let novedades = null;
  let error = null;
  try {
    const datos = await consultar(tracking.contenedor);
    ({ cambios, novedades } = aplicarConsulta(tracking, datos, { fuente: T.naviera(tracking.naviera).id, ahora }));
  } catch (err) {
    error = err.message;
    cambios = { consultado_at: ahora, consulta_error: err.message };
  }
  cambios.updated_at = ahora;
  const { data, error: errDb } = await supabase.from('trackings').update(cambios).eq('id', tracking.id).select().single();
  if (errDb) throw errDb;
  return { tracking: data, novedades, error, automatica: true };
}

// Lleva el arribo y la etapa del contenedor a sus importaciones.
async function sincronizarImportaciones(supabase, tracking) {
  const ids = (Array.isArray(tracking?.importaciones) ? tracking.importaciones : []).map(v => v.id).filter(Boolean);
  if (!ids.length) return { actualizadas: [], errores: [] };
  const { data, error } = await supabase.from('importaciones').select('*').in('id', ids);
  if (error) throw error;

  const paso = T.estadoInfo(tracking.estado).paso;
  const actualizadas = [];
  const errores = [];
  for (const imp of data || []) {
    const estado = imp.estado || imp.status;
    if (T.ESTADOS_LLEGADOS.includes(estado) || T.ESTADOS_CANCELADOS.includes(estado)) continue;
    const f = {};
    if (tracking.eta && imp.llegada !== tracking.eta) f.llegada = tracking.eta;
    if (paso >= 4 && ['ordered', 'in_transit', 'en_transito'].includes(estado)) f.estado = 'en_aduana';
    else if (paso === 3 && estado === 'ordered') f.estado = 'in_transit';
    if (!Object.keys(f).length) continue;
    // Con puesta en puerto, el pago al importador vence al arribo: se corre su fecha estimada
    // (salvo que se haya puesto a mano) conservando lo ya marcado.
    if (f.llegada && Costo.esPuerto(imp)) f.pagos = Costo.armarPagos({ ...imp, llegada: f.llegada }, imp.pagos);
    const { error: e } = await supabase.from('importaciones').update(f).eq('id', imp.id);
    if (e) { errores.push({ id: imp.id, error: e.message }); continue; }
    actualizadas.push({
      id: imp.id,
      ...(f.llegada ? { llegadaAntes: imp.llegada || null, llegada: f.llegada } : {}),
      ...(f.estado ? { estadoAntes: estado, estado: f.estado } : {}),
    });
  }
  return { actualizadas, errores };
}

// Un error al mover las importaciones no deshace lo guardado del contenedor: se devuelve.
async function sincronizarSeguro(supabase, tracking) {
  try {
    return await sincronizarImportaciones(supabase, tracking);
  } catch (err) {
    console.error('Error sincronizando importaciones del contenedor:', err);
    return { actualizadas: [], errores: [{ id: null, error: err.message }] };
  }
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// El aviso de Telegram cuando cambia el arribo o el contenedor zarpa / llega / sale del puerto.
// Devuelve null si no hay nada que avisar. `importaciones` y `proveedores` son las filas de la
// base (para nombrar las PIs y sumar lo que falta pagar).
function mensajeNovedades(tracking, novedades, importaciones = [], proveedores = []) {
  if (!novedades) return null;
  const avisaEstado = novedades.cambioEstado && ESTADOS_AVISADOS.includes(novedades.estadoNuevo);
  if (!novedades.cambioEta && !avisaEstado) return null;

  const destino = T.nombrePuerto(tracking.puerto_destino) || 'destino';
  const lineas = [`🚢 <b>Contenedor ${esc(T.formatearContenedor(tracking.contenedor))}</b> · ${esc(T.naviera(tracking.naviera).id)}`];

  if (avisaEstado) {
    const origen = T.nombrePuerto(tracking.puerto_origen);
    const buque = tracking.buque ? ` en el ${esc(tracking.buque)}` : '';
    const textos = {
      navegando: T.estadoInfo(novedades.estadoAntes).paso === 3
        ? `⛴️ Salió del transbordo y sigue viaje${buque}.`
        : `⛴️ Zarpó${origen ? ` de ${esc(origen)}` : ''}${buque}.`,
      transbordo: '🔁 Llegó a un puerto de transbordo.',
      en_puerto: `🏁 Llegó al puerto de ${esc(destino)}.`,
      retirado: `✅ Salió de la terminal de ${esc(destino)}.`,
    };
    lineas.push(textos[novedades.estadoNuevo]);
  }

  if (novedades.cambioEta) {
    const dif = T.diasEntre(novedades.etaAntes, novedades.etaNueva);
    lineas.push(`📅 El arribo a ${esc(destino)} pasó del ${fmtFecha(novedades.etaAntes)} al <b>${fmtFecha(novedades.etaNueva)}</b>` +
      ` (${Math.abs(dif)} día${Math.abs(dif) === 1 ? '' : 's'} ${dif > 0 ? 'después' : 'antes'}).`);
  } else if (T.estadoInfo(novedades.estadoNuevo).paso < 4 && tracking.eta) {
    lineas.push(`📅 Arribo estimado a ${esc(destino)}: <b>${fmtFecha(tracking.eta)}</b>.`);
  }

  const provPorId = {};
  (proveedores || []).forEach(p => { if (p?.id) provPorId[p.id] = p.nombre; });
  const resumen = T.resumenContenedor(tracking, importaciones);
  if (resumen.pis.length) {
    const pis = resumen.pis.map(p => {
      const nombre = p.pi ? `PI ${p.pi}` : (p.descripcion || 'importación');
      const prov = p.imp?.proveedor_id ? provPorId[p.imp.proveedor_id] : null;
      return esc(nombre) + (prov ? ` (${esc(prov)})` : '');
    });
    lineas.push(`📦 Trae: ${pis.join(', ')}.`);
  }
  if (resumen.pendiente > 0 && T.estadoInfo(novedades.estadoNuevo).paso < 5) {
    lineas.push(`💵 Para el arribo falta abonar <b>USD ${resumen.pendiente.toFixed(2)}</b>.`);
  }
  return lineas.join('\n');
}

module.exports = {
  MIGRACION, MSG_MIGRACION, ESTADOS_AVISADOS,
  faltaMigracionTracking, normalizarVinculos, normalizarTracking, completarLlegadasCalculadas,
  historialEta, aplicarConsulta, actualizarDesdeNaviera, sincronizarImportaciones, sincronizarSeguro,
  mensajeNovedades,
};
