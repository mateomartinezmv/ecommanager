// api/_revisiones.js
// Lo que comparten las revisiones periódicas que analiza una tarea programada de Claude
// (Ads semanal en _adsRevision.js, auditoría de publicaciones en _auditoriaPubs.js).
//
// Un cron corre cada "parte" en una invocación propia (?parte=...) y guarda su resultado en
// una tabla <revision>_partes con { clave de período, parte, ok, error, datos }. Si una parte
// falla, queda anotada y las demás siguen: la tarea analiza lo que hay y dice qué faltó.

function hoyEnUruguay(fecha = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(fecha);
}

function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Miniaturas y links pesan y no le dicen nada a quien analiza.
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

// { ok, datos, error } a partir de las respuestas de los endpoints que se llamaron. Un
// endpoint falló si respondió 4xx/5xx, nada, u ok: false.
function resultado(datos, respuestas) {
  const fallas = respuestas
    .filter(r => r.status >= 400 || !r.data || r.data.ok === false)
    .map(r => r.data?.error || r.data?.mensaje || `HTTP ${r.status}`);
  return { ok: fallas.length === 0, datos, error: fallas.length ? fallas.join(' · ') : null };
}

// Corre una parte y la guarda. `clave` es { columna: valor } del período (semana, fecha).
async function correrYGuardar({ supabase, tabla, partes, parte, clave, contexto }) {
  const fn = partes[parte];
  if (!fn) throw new Error(`Parte desconocida: ${parte}. Opciones: ${Object.keys(partes).join(', ')}`);

  let r;
  try {
    r = await fn(contexto);
  } catch (err) {
    r = { ok: false, datos: null, error: err.message };
  }

  const { error } = await supabase.from(tabla).upsert({
    ...clave,
    parte,
    ok: r.ok,
    error: r.error,
    datos: r.datos,
    generado_at: new Date().toISOString(),
  });
  if (error) throw new Error(`No se pudo guardar ${parte}: ${error.message}`);
  return { ...clave, parte, ok: r.ok, error: r.error };
}

module.exports = { hoyEnUruguay, sumarDias, aligerar, resultado, correrYGuardar };
