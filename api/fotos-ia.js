// api/fotos-ia.js
// Fotos de producto con IA (Higgsfield) — Marketing → 📸 Fotos.
//
//   GET  /api/fotos-ia                          → { configurado, lotes } (los pedidos recientes)
//   GET  /api/fotos-ia?lote=UUID                → { fotos } de ese pedido
//   POST /api/fotos-ia?accion=preparar          { skus }                       → variantes con sus fotos de referencia + textos propuestos
//   POST /api/fotos-ia?accion=generar           { variantes, tipos, textos }   → crea el pedido (no gasta todavía)
//   POST /api/fotos-ia?accion=avanzar           { lote }                       → manda a Higgsfield, trae las terminadas, les pone el logo
//   POST /api/fotos-ia?accion=regenerar         { id }                         → la vuelve a pedir igual
//   POST /api/fotos-ia?accion=descartar         { id }
//   POST /api/fotos-ia?accion=publicar          { lote, sku, conservar }       → reemplaza las fotos de todas las publicaciones de ese SKU
//
// Las imágenes tardan alrededor de un minuto cada una y la función se corta a los 60 s, así
// que nada espera a Higgsfield: "avanzar" hace lo que puede en ~45 s y la pantalla lo vuelve
// a llamar mientras quede algo en camino. Cada paso toma la fila con un update condicional
// (sólo si sigue en el estado esperado), así dos pestañas abiertas no mandan dos veces lo
// mismo ni se cobra una imagen dos veces.

const crypto = require('crypto');
const { getSupabase } = require('./_supabase');
const { getMeliToken } = require('./_meliToken');
const { meliIdsDe } = require('./_meliIds');
const { meliGet, meliFetch, mensajeDeError } = require('./_meliPublicaciones');
const { pedirTexto } = require('./_angulosIA');
const hf = require('./_higgsfield');
const { componer } = require('./_fotosLogo');
const F = require('./_fotosIA');

const BUCKET = 'fotos-ia';
const TOPE_MS = 45000;

const faltaMigracion = err => err && (['42P01', 'PGRST205'].includes(err.code) || /fotos_ia.*(does not exist|schema cache)|relation .*fotos_ia/i.test(err.message || ''));
const AVISO_MIGRACION = 'Falta correr la migración de fotos con IA en Supabase (supabase/migrations/20261107000000_add_fotos_ia.sql).';

const ahoraIso = () => new Date().toISOString();

// Pasa una fila de un estado a otro sólo si sigue en el esperado. Devuelve la fila o null si
// otro proceso ya la tomó.
async function tomar(supabase, id, desde, cambios) {
  const { data, error } = await supabase.from('fotos_ia')
    .update({ ...cambios, estado_desde: ahoraIso() })
    .eq('id', id).in('estado', [].concat(desde))
    .select();
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function filasDelLote(supabase, lote) {
  const { data, error } = await supabase.from('fotos_ia').select('*').eq('lote', lote).order('id');
  if (error) throw error;
  return data || [];
}

// ── Preparar ──────────────────────────────────────────────────────

async function preparar(supabase, skus) {
  const pedidos = [...new Set((skus || []).map(s => String(s).trim()).filter(Boolean))];
  if (!pedidos.length) return { status: 400, cuerpo: { error: 'Elegí al menos una variante.' } };

  const { data: productos, error } = await supabase.from('productos')
    .select('sku, nombre, grupo, subgrupo, meli_id, meli_ids').in('sku', pedidos);
  if (error) throw error;

  let token = null;
  try { token = await getMeliToken(); } catch { /* sin MELI: se avisa por variante */ }

  const variantes = [];
  let base = null;   // la primera publicación que se pudo leer: de ahí salen los textos
  for (const sku of pedidos) {
    const p = (productos || []).find(x => x.sku === sku);
    if (!p) { variantes.push({ sku, nombre: sku, referencias: [], aviso: 'No está en el CRM.' }); continue; }
    const meliId = meliIdsDe(p)[0] || null;
    const v = { sku, nombre: p.nombre, meli_id: meliId, color: F.colorDe(null, p), referencias: [], titulo: null, aviso: null };
    if (!meliId) v.aviso = 'No tiene publicación de MELI enlazada: no hay foto del producto real.';
    else if (!token) v.aviso = 'MELI no está conectado.';
    else {
      try {
        const item = await meliGet(token, `/items/${meliId}?attributes=id,title,pictures,attributes,variations,category_id`);
        v.titulo = item.title || null;
        v.color = F.colorDe(item, p);
        v.referencias = F.referenciasDe(item);
        if (!v.referencias.length) v.aviso = 'La publicación no tiene fotos para usar de referencia.';
        if (!base) base = { item, producto: p };
      } catch (e) {
        v.aviso = `No se pudo leer ${meliId}: ${e.message}`;
      }
    }
    variantes.push(v);
  }

  // Los textos los propone la IA a partir de la publicación; el vendedor los corrige antes
  // de generar. Si la IA no está, quedan vacíos y se completan a mano.
  let textos = F.textosVacios();
  let avisoTextos = null;
  if (!base) {
    avisoTextos = 'No se pudo leer ninguna publicación: completá los textos a mano.';
  } else {
    try {
      let descripcion = '';
      try {
        const d = await meliGet(token, `/items/${base.item.id}/description`);
        descripcion = d.plain_text || d.text || '';
      } catch { /* sin descripción, igual alcanza con la ficha */ }
      const texto = await pedirTexto(F.construirPromptTextos({
        titulo: base.item.title,
        descripcion,
        atributos: base.item.attributes,
        producto: [base.producto.grupo, base.producto.subgrupo].filter(Boolean).join(' / ') || base.producto.nombre,
        variantes,
      }), 2000);
      const propuesta = F.extraerObjetoJson(texto);
      if (propuesta) textos = F.normalizarTextos(propuesta);
      else avisoTextos = 'La IA no devolvió textos utilizables: completalos a mano.';
    } catch (e) {
      avisoTextos = `No se pudieron proponer los textos (${e.message}). Completalos a mano.`;
    }
  }

  return { status: 200, cuerpo: { variantes, textos, avisoTextos } };
}

// ── Generar (crear el pedido) ─────────────────────────────────────

async function generar(supabase, body) {
  if (!hf.configurado()) return { status: 400, cuerpo: { error: 'Falta HIGGSFIELD_API_KEY en Vercel (ID:SECRET de console.higgsfield.ai).' } };

  const variantes = (body.variantes || []).map(v => ({
    sku: String(v.sku || '').trim(),
    nombre: v.nombre,
    color: v.color,
    // Sólo URLs https: van tal cual a Higgsfield, que las descarga.
    referencias: (v.referencias || []).filter(u => typeof u === 'string' && /^https:\/\//.test(u)),
  }));
  const plan = F.planLote({ variantes, tipos: body.tipos, textos: body.textos });
  if (plan.error) return { status: 400, cuerpo: { error: plan.error } };

  const lote = crypto.randomUUID();
  const { data, error } = await supabase.from('fotos_ia')
    .insert(plan.filas.map(f => ({ ...f, lote })))
    .select();
  if (faltaMigracion(error)) return { status: 503, cuerpo: { error: AVISO_MIGRACION } };
  if (error) throw error;
  return { status: 200, cuerpo: { lote, fotos: (data || []).sort((a, b) => a.id - b.id) } };
}

// ── Avanzar ───────────────────────────────────────────────────────

// Baja la imagen terminada, le pone el logo y la guarda en Storage.
async function terminar(supabase, fila, url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`No se pudo bajar la imagen de Higgsfield (HTTP ${res.status})`);
  const original = Buffer.from(await res.arrayBuffer());
  const { buffer } = await componer(original, { conLogo: fila.tipo !== 'portada' });

  const ruta = `${fila.lote}/${fila.sku}-${fila.tipo}-${fila.id}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(ruta, buffer, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`No se pudo guardar en Storage: ${error.message}`);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(ruta);
  return data.publicUrl;
}

async function avanzar(supabase, lote) {
  const inicio = Date.now();
  const queda = () => Date.now() - inicio < TOPE_MS;

  const { data: activas, error } = await supabase.from('fotos_ia')
    .select('*').in('estado', F.ESTADOS_ACTIVOS).order('id');
  if (faltaMigracion(error)) return { status: 503, cuerpo: { error: AVISO_MIGRACION } };
  if (error) throw error;

  // 1. Lo que quedó trabado de una corrida que se cortó.
  for (const c of F.resolverTrabadas(activas)) {
    const desde = activas.find(f => f.id === c.id).estado;
    await tomar(supabase, c.id, desde, { estado: c.estado, ...(c.error ? { error: c.error } : {}) });
  }

  // 2. Las que Higgsfield está haciendo: ¿terminaron?
  const { data: generando } = await supabase.from('fotos_ia')
    .select('*').eq('estado', 'generando').order('id').limit(12);
  for (const f of generando || []) {
    if (!queda()) break;
    let st;
    try { st = await hf.estado(f.hf_request_id); } catch { continue; }   // se reintenta en la próxima vuelta
    if (!st.terminal) continue;
    if (st.status !== 'completed') {
      const motivo = st.status === 'nsfw' ? 'Higgsfield la bloqueó por moderación (no se cobra).'
        : st.status === 'canceled' ? 'Se canceló en Higgsfield.' : 'Higgsfield no pudo generarla (no se cobra).';
      await tomar(supabase, f.id, 'generando', { estado: 'error', error: motivo });
      continue;
    }
    const url = F.urlsDeSalida(st.respuesta)[0];
    if (!url) { await tomar(supabase, f.id, 'generando', { estado: 'error', error: 'Higgsfield terminó sin devolver la imagen.' }); continue; }
    const fila = await tomar(supabase, f.id, 'generando', { estado: 'procesando', hf_url: url });
    if (!fila) continue;
    try {
      const final = await terminar(supabase, fila, url);
      await tomar(supabase, f.id, 'procesando', { estado: 'lista', url_final: final, error: null });
    } catch (e) {
      // La imagen sigue en Higgsfield: vuelve a 'generando' y la próxima vuelta la reintenta.
      await tomar(supabase, f.id, 'procesando', { estado: 'generando', error: e.message });
    }
  }

  // 3. Mandar las que faltan, sin pasar del límite de simultáneas de la cuenta.
  const { count: enVuelo } = await supabase.from('fotos_ia')
    .select('id', { count: 'exact', head: true }).in('estado', ['enviando', 'generando']);
  let lugares = F.EN_VUELO_MAX - (enVuelo || 0);
  if (lugares > 0 && queda()) {
    const { data: pendientes } = await supabase.from('fotos_ia')
      .select('*').eq('estado', 'pendiente').order('id').limit(lugares);
    for (const p of pendientes || []) {
      if (lugares <= 0 || !queda()) break;
      const fila = await tomar(supabase, p.id, 'pendiente', { estado: 'enviando' });
      if (!fila) continue;
      try {
        const requestId = await hf.enviar(F.MODELO_HF, F.inputHiggsfield(fila));
        await tomar(supabase, p.id, 'enviando', { estado: 'generando', hf_request_id: requestId, error: null });
        lugares--;
      } catch (e) {
        const que = e.status === 0 ? 'rechazada' : F.clasificarFalloEnvio(e.status);
        if (que === 'reintentar') {
          await tomar(supabase, p.id, 'enviando', { estado: 'pendiente' });
          break;   // Higgsfield está lleno: el resto espera a la próxima vuelta
        }
        await tomar(supabase, p.id, 'enviando', {
          estado: 'error',
          error: que === 'incierta'
            ? `${e.message} No se sabe si Higgsfield la tomó: revisá la consola antes de regenerarla.`
            : e.message,
        });
        // Sin saldo o clave mala: no tiene sentido seguir mandando las demás.
        if ([0, 401, 402, 403].includes(e.status)) break;
      }
    }
  }

  return { status: 200, cuerpo: { fotos: lote ? await filasDelLote(supabase, lote) : [] } };
}

// ── Regenerar / descartar ─────────────────────────────────────────

async function regenerar(supabase, id) {
  const { data: f, error } = await supabase.from('fotos_ia').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!f) return { status: 404, cuerpo: { error: 'Esa foto no existe.' } };
  if (F.ESTADOS_ACTIVOS.includes(f.estado)) return { status: 409, cuerpo: { error: 'Esa foto todavía se está generando.' } };

  const { data, error: errIns } = await supabase.from('fotos_ia').insert({
    lote: f.lote, sku: f.sku, tipo: f.tipo, compartida: f.compartida,
    prompt: f.prompt, referencias: f.referencias, estado: 'pendiente',
  }).select().single();
  if (errIns) throw errIns;
  if (f.estado !== 'publicada') await tomar(supabase, f.id, f.estado, { estado: 'descartada' });
  return { status: 200, cuerpo: data };
}

async function descartar(supabase, id) {
  const fila = await tomar(supabase, id, ['lista', 'error', 'pendiente'], { estado: 'descartada' });
  if (!fila) return { status: 409, cuerpo: { error: 'Esa foto ya no se puede descartar (se está generando o ya se publicó).' } };
  return { status: 200, cuerpo: fila };
}

// ── Publicar en MELI ──────────────────────────────────────────────

async function publicar(supabase, { lote, sku, conservar }) {
  if (!lote || !sku) return { status: 400, cuerpo: { error: 'Falta el pedido o el SKU.' } };
  const filas = await filasDelLote(supabase, lote);
  const fotos = F.fotosParaPublicar(filas, sku);
  if (!fotos.length) return { status: 400, cuerpo: { error: `${sku} no tiene fotos listas para publicar.` } };

  const { data: producto, error } = await supabase.from('productos')
    .select('sku, meli_id, meli_ids').eq('sku', sku).maybeSingle();
  if (error) throw error;
  const ids = meliIdsDe(producto);
  if (!ids.length) return { status: 400, cuerpo: { error: `${sku} no tiene publicaciones de MELI enlazadas.` } };

  let token;
  try { token = await getMeliToken(); } catch { return { status: 400, cuerpo: { error: 'MELI no está conectado. Autorizá la app primero.' } }; }

  const resultados = [];
  // Ids que MELI les dio a las fotos nuevas en la primera publicación: las demás (los
  // ángulos) las reusan sin volver a descargarlas, y quedan exactamente iguales.
  let idsNuevos = null;
  for (const meliId of ids) {
    let item = null;
    try {
      item = await meliGet(token, `/items/${meliId}?attributes=id,title,status,catalog_listing,variations,pictures`);
    } catch (e) {
      resultados.push({ meli_id: meliId, ok: false, error: e.message });
      continue;
    }
    const motivo = F.motivoNoPublicable(item);
    if (motivo) { resultados.push({ meli_id: meliId, titulo: item.title, ok: false, error: motivo }); continue; }

    const actuales = (item.pictures || []).map(p => p.id).filter(Boolean);
    const porUrl = fotos.map(f => ({ source: f.url_final }));
    let nuevas = idsNuevos ? idsNuevos.map(id => ({ id })) : porUrl;
    let r = await meliFetch(token, `/items/${meliId}`, { method: 'PUT', body: JSON.stringify(F.cuerpoFotosMeli(nuevas, actuales, conservar)) });
    if (!r.ok && idsNuevos) {
      nuevas = porUrl;
      r = await meliFetch(token, `/items/${meliId}`, { method: 'PUT', body: JSON.stringify(F.cuerpoFotosMeli(nuevas, actuales, conservar)) });
    }
    if (!r.ok) {
      resultados.push({ meli_id: meliId, titulo: item.title, ok: false, error: mensajeDeError(r.data, r.status) });
      continue;
    }
    const quedaron = (r.data.pictures || []).map(p => p.id).filter(Boolean);
    if (!idsNuevos && quedaron.length >= fotos.length) idsNuevos = quedaron.slice(0, fotos.length);
    resultados.push({ meli_id: meliId, titulo: item.title, ok: true, fotos: quedaron.length });
  }

  if (resultados.some(r => r.ok)) {
    await supabase.from('fotos_ia')
      .update({ estado: 'publicada', publicada_at: ahoraIso(), estado_desde: ahoraIso() })
      .in('id', fotos.map(f => f.id)).in('estado', ['lista', 'publicada']);
  }
  return {
    status: 200,
    cuerpo: { ok: resultados.some(r => r.ok), publicadas: resultados.filter(r => r.ok).length, fallidas: resultados.filter(r => !r.ok).length, resultados },
  };
}

// ── Lista de pedidos ──────────────────────────────────────────────

async function resumen(supabase) {
  const configurado = { higgsfield: hf.configurado(), ia: !!process.env.ANTHROPIC_API_KEY };
  const { data, error } = await supabase.from('fotos_ia')
    .select('lote, sku, tipo, estado, created_at').order('id', { ascending: false }).limit(400);
  if (faltaMigracion(error)) return { configurado, lotes: [], faltaMigracion: true, aviso: AVISO_MIGRACION };
  if (error) throw error;

  const porLote = new Map();
  for (const f of data || []) {
    if (!porLote.has(f.lote)) porLote.set(f.lote, { lote: f.lote, created_at: f.created_at, skus: new Set(), total: 0, listas: 0, publicadas: 0, activas: 0, errores: 0 });
    const l = porLote.get(f.lote);
    if (f.created_at < l.created_at) l.created_at = f.created_at;
    if (f.estado === 'descartada') continue;
    l.skus.add(f.sku);
    l.total++;
    if (f.estado === 'lista') l.listas++;
    if (f.estado === 'publicada') l.publicadas++;
    if (F.ESTADOS_ACTIVOS.includes(f.estado)) l.activas++;
    if (f.estado === 'error') l.errores++;
  }
  const lotes = [...porLote.values()].slice(0, 20).map(l => ({ ...l, skus: [...l.skus] }));
  return { configurado, lotes };
}

module.exports = async (req, res) => {
  const supabase = getSupabase();
  const { accion, lote } = req.query;
  const body = req.body || {};

  try {
    if (req.method === 'GET') {
      if (lote) {
        const { data, error } = await supabase.from('fotos_ia').select('*').eq('lote', lote).order('id');
        if (faltaMigracion(error)) return res.status(503).json({ error: AVISO_MIGRACION });
        if (error) throw error;
        return res.json({ fotos: data || [] });
      }
      return res.json(await resumen(supabase));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const acciones = {
      preparar: () => preparar(supabase, body.skus),
      generar: () => generar(supabase, body),
      avanzar: () => avanzar(supabase, body.lote),
      regenerar: () => regenerar(supabase, Number(body.id)),
      descartar: () => descartar(supabase, Number(body.id)),
      publicar: () => publicar(supabase, body),
    };
    if (!acciones[accion]) return res.status(400).json({ error: 'Acción desconocida' });
    const { status, cuerpo } = await acciones[accion]();
    return res.status(status).json(cuerpo);
  } catch (err) {
    console.error('Error en fotos-ia.js:', err);
    if (faltaMigracion(err)) return res.status(503).json({ error: AVISO_MIGRACION });
    return res.status(500).json({ error: err.message });
  }
};
