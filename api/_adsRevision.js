// api/_adsRevision.js
// Lo que junta el cron de la revisión semanal de Ads (api/cron/ads-semanal.js) para que la
// tarea programada de Claude lo analice el lunes.
//
// Cada parte llama al mismo endpoint que usa la pestaña del CRM (Ads, Promos) y guarda su
// respuesta en ads_revision_partes, aligerada: sin miniaturas ni links, que pesan y no
// dicen nada. Las partes corren en invocaciones separadas del cron (?parte=...) para que
// ninguna se coma el tiempo de las otras.

const { invocar } = require('./_invocar');

const TABLA = 'ads_revision_partes';

// ── La semana que se revisa ────────────────────────────────────────────────────────────
// Siempre la última semana cerrada de lunes a domingo, en hora de Montevideo: si el cron
// corre el lunes, es la que terminó ayer; si se corre a mano un miércoles, la misma.
function hoyEnUruguay(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(fecha);
}

function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function semanaCerrada(fecha = new Date()) {
  const hoy = hoyEnUruguay(fecha);
  const dow = new Date(`${hoy}T12:00:00Z`).getUTCDay();        // 0 = domingo
  const lunesDeEsta = sumarDias(hoy, -((dow + 6) % 7));
  const desde = sumarDias(lunesDeEsta, -7);
  return {
    desde,
    hasta: sumarDias(desde, 6),
    anterior: { desde: sumarDias(desde, -7), hasta: sumarDias(desde, -1) },
  };
}

// ── Aligerar ───────────────────────────────────────────────────────────────────────────
const SOBRAN = new Set(['thumbnail', 'permalink', 'imagen', 'imagenes', 'pictures', 'foto', 'fotos']);

function aligerar(valor) {
  if (Array.isArray(valor)) return valor.map(aligerar);
  if (valor && typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (SOBRAN.has(k)) continue;
      out[k] = aligerar(v);
    }
    return out;
  }
  return valor;
}

// Promos: interesa lo que pide una decisión, no el catálogo entero. Quedan las
// publicaciones con invitaciones pendientes, con una promo corriendo fuera de las reglas o
// con "precio alto" según MELI.
function promosParaRevisar(data) {
  if (!data?.ok) return data;
  const productos = (data.productos || [])
    .map(p => ({
      ...p,
      publicaciones: (p.publicaciones || []).filter(pub =>
        (pub.propuestas || []).length > 0 ||
        pub.vigente?.evaluacion?.veredicto === 'rechazar' ||
        (pub.referencia && pub.referencia.baja_pct > 0)),
    }))
    .filter(p => p.publicaciones.length > 0);
  return aligerar({ ok: true, reglas: data.reglas, resumen: data.resumen, productos });
}

// ── Las partes ─────────────────────────────────────────────────────────────────────────
// Cada una recibe la semana y devuelve { ok, datos, error }. Los handlers se cargan adentro
// para que un test pueda reemplazarlos.
const PARTES = {
  // Totales por campaña: la semana revisada y la anterior, para comparar.
  async campanas(sem) {
    const h = require('./meli/ads-campanas');
    const [actual, anterior] = await Promise.all([
      invocar(h, { query: { desde: sem.desde, hasta: sem.hasta } }),
      invocar(h, { query: { desde: sem.anterior.desde, hasta: sem.anterior.hasta } }),
    ]);
    return resultado({ semana: actual.data, anterior: anterior.data }, [actual, anterior]);
  },

  // Cada anuncio de todas las campañas, con margen, ROAS de equilibrio y ganancia.
  async anuncios(sem) {
    const r = await invocar(require('./meli/ads-anuncios'),
      { query: { campaign_id: 'todas', desde: sem.desde, hasta: sem.hasta } });
    return resultado(aligerar(r.data), [r]);
  },

  // Qué anunciar, qué apagar y qué escalar, sobre 30 días (lo que muestra la pestaña).
  async recomendaciones() {
    const r = await invocar(require('./meli/ads-recomendaciones'), { query: { dias: '30' } });
    return resultado(aligerar(r.data), [r]);
  },

  // Invitaciones a promos con su veredicto según las reglas de Promos MELI.
  async promos() {
    const r = await invocar(require('./meli/promos'));
    return resultado(promosParaRevisar(r.data), [r]);
  },

  // Los cambios hechos en Ads con su antes y después, y la evolución semanal por SKU.
  async cambios() {
    const [cambios, evolucion] = await Promise.all([
      invocar(require('./meli/ads-cambios')),
      invocar(require('./meli/ads-evolucion'), { query: { semanas: '8' } }),
    ]);
    return resultado({ cambios: cambios.data, evolucion: evolucion.data }, [cambios, evolucion]);
  },
};

function resultado(datos, respuestas) {
  const fallas = respuestas
    .filter(r => r.status >= 400 || !r.data || r.data.ok === false)
    .map(r => r.data?.error || r.data?.mensaje || `HTTP ${r.status}`);
  return { ok: fallas.length === 0, datos, error: fallas.length ? fallas.join(' · ') : null };
}

async function correrParte(supabase, parte, fecha = new Date()) {
  const fn = PARTES[parte];
  if (!fn) throw new Error(`Parte desconocida: ${parte}. Opciones: ${Object.keys(PARTES).join(', ')}`);
  const sem = semanaCerrada(fecha);

  let r;
  try {
    r = await fn(sem);
  } catch (err) {
    r = { ok: false, datos: null, error: err.message };
  }

  const { error } = await supabase.from(TABLA).upsert({
    semana: sem.desde,
    parte,
    ok: r.ok,
    error: r.error,
    datos: r.datos,
    generado_at: new Date().toISOString(),
  });
  if (error) throw new Error(`No se pudo guardar ${parte}: ${error.message}`);
  return { semana: sem.desde, parte, ok: r.ok, error: r.error };
}

module.exports = {
  TABLA, PARTES, semanaCerrada, hoyEnUruguay, aligerar, promosParaRevisar, correrParte,
};
