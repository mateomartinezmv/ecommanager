// api/cron/instagram-publicar.js
// Cron — cada 5 minutos.
//
// Publica en Instagram y en la página de Facebook lo que está programado en
// instagram_publicaciones y ya llegó su hora (cada fila dice en qué redes sale).
// La API de Meta no programa publicaciones: publica en el momento, así que el horario lo
// cumple este cron (con hasta 5 minutos de atraso).
//
// Para no publicar dos veces lo mismo, cada fila se "toma" pasándola de 'programado' a
// 'publicando' con un UPDATE condicionado: si el cron y el botón "Publicar ahora" del CRM
// corren a la vez, solo uno de los dos la consigue. Una fila que quedó en 'publicando' más
// de 15 minutos (se cortó la función a mitad de camino) no se reintenta sola, porque pudo
// haber salido: se marca con error para que alguien mire las redes antes de reintentar.
//
// Vercel corta la función a los 60 segundos. Para no quedar a mitad de camino, antes de
// empezar cada red se mira el reloj: si ya no queda margen, lo que salió queda guardado y la
// fila vuelve a 'programado' para que la próxima vuelta publique solo lo que falta.
//
// Avisa por Telegram cada publicación que sale y cada una que falla.

const { getSupabase } = require('../_supabase');
const { publicar, publicarFacebook } = require('../_metaInstagram');

const POR_VUELTA = 5;
// Pasado este tiempo desde que arrancó la función no se empieza ninguna red nueva: lo que
// tarda una (un carrusel de 10 en Instagram) tiene que entrar en lo que queda hasta los 60 s.
const MARGEN_MS = 30 * 1000;
const TRABADA_MS = 15 * 60 * 1000;
// "Instagram sigue procesando la imagen" no es un error de la publicación: se vuelve a
// intentar en las próximas vueltas antes de darla por fallida.
const MAX_INTENTOS_PROCESANDO = 3;

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).catch(err => console.error('Telegram error:', err.message));
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TIPO_LABEL = { post: 'Post', carrusel: 'Carrusel', historia: 'Historia' };
const RED_LABEL = { instagram: 'Instagram', facebook: 'Facebook' };

// Toma la fila (si sigue en alguno de los estados de `desde`) y la publica en sus redes.
// Devuelve null si no se pudo tomar, { ok, ... } si salió en todas o { error, ... } si alguna
// falló. Cada red que sale se guarda en el momento (ig_media_id / fb_post_id): al reintentar
// se publica solo en las que faltan, así nada sale dos veces.
// `hasta` (ms) es la hora a partir de la cual no se empieza otra red: las que no llegan
// quedan para la próxima vuelta y se devuelve { pendiente: true }.
// `fetchImpl` y `espera` son para los tests.
async function publicarFila(supabase, id, { desde = ['programado'], hasta, fetchImpl, espera } = {}) {
  const { data: tomadas, error: errTomar } = await supabase.from('instagram_publicaciones')
    .update({ estado: 'publicando', publicando_desde: new Date().toISOString() })
    .eq('id', id).in('estado', desde)
    .select();
  if (errTomar) throw errTomar;
  const pub = tomadas && tomadas[0];
  if (!pub) return null;
  const intentos = (pub.intentos || 0) + 1;
  // Las filas de antes de que existiera Facebook no tienen `redes`: eran solo de Instagram.
  const redes = pub.redes && pub.redes.length ? pub.redes : ['instagram'];
  const deps = { ...(fetchImpl && { fetchImpl }), espera };
  const guardar = cambios => supabase.from('instagram_publicaciones').update(cambios).eq('id', id);

  const errores = [];
  let cuenta = null;
  try {
    ({ data: cuenta } = await supabase.from('meta_tokens').select('*').eq('id', 1).maybeSingle());
  } catch (err) {
    errores.push(...redes.map(red => ({ red, message: err.message })));
  }

  const pendientes = [];
  if (!errores.length) {
    for (const red of redes) {
      const hecha = red === 'instagram' ? pub.ig_media_id : pub.fb_post_id;
      if (!hecha && hasta && Date.now() > hasta) { pendientes.push(red); continue; }
      try {
        if (red === 'instagram' && !pub.ig_media_id) {
          const { mediaId, permalink } = await publicar(pub, cuenta, deps);
          Object.assign(pub, { ig_media_id: mediaId, permalink });
          await guardar({ ig_media_id: mediaId, permalink });
        } else if (red === 'facebook' && !pub.fb_post_id) {
          const { postId, permalink } = await publicarFacebook(pub, cuenta, deps);
          Object.assign(pub, { fb_post_id: postId, fb_permalink: permalink });
          await guardar({ fb_post_id: postId, fb_permalink: permalink });
        }
      } catch (err) {
        errores.push({ red, message: err.message });
      }
    }
  }

  const resumen = { id, tipo: pub.tipo, redes, permalink: pub.permalink || null, fbPermalink: pub.fb_permalink || null };
  if (pendientes.length && !errores.length) {
    await guardar({ estado: 'programado', intentos });
    return { pendiente: true, faltan: pendientes, ...resumen };
  }
  if (!errores.length) {
    await guardar({ estado: 'publicado', publicado_at: new Date().toISOString(), intentos, error: null });
    return { ok: true, ...resumen };
  }

  const mensaje = redes.length > 1
    ? errores.map(e => `${RED_LABEL[e.red]}: ${e.message}`).join(' · ')
    : errores[0].message;
  const procesando = errores.every(e => /sigue procesando/i.test(e.message));
  const reintentar = procesando && intentos < MAX_INTENTOS_PROCESANDO;
  await guardar({ estado: reintentar ? 'programado' : 'error', intentos, error: mensaje });
  const fallidas = errores.map(e => e.red);
  return { error: mensaje, reintentar, fallidas, salieron: redes.filter(r => !fallidas.includes(r)), ...resumen };
}

const nombres = redes => redes.map(r => RED_LABEL[r] || r).join(' y ');

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  try {
    const ahora = new Date();

    // Las que se cortaron a mitad de camino: no se reintentan solas porque pudieron salir.
    const { data: trabadas } = await supabase.from('instagram_publicaciones')
      .update({ estado: 'error', error: 'Se cortó mientras se publicaba. Fijate en Instagram y Facebook si salió antes de reintentar.' })
      .eq('estado', 'publicando')
      .lt('publicando_desde', new Date(ahora.getTime() - TRABADA_MS).toISOString())
      .select('id, tipo');

    const { data: vencidas, error } = await supabase.from('instagram_publicaciones')
      .select('id')
      .eq('estado', 'programado')
      .lte('programado_para', ahora.toISOString())
      .order('programado_para', { ascending: true })
      .limit(POR_VUELTA);
    if (error) throw error;

    const hasta = ahora.getTime() + MARGEN_MS;
    const resultados = [];
    for (const { id } of vencidas || []) {
      if (Date.now() > hasta) break; // las que quedan salen en la próxima vuelta
      const r = await publicarFila(supabase, id, { hasta });
      if (r) resultados.push(r);
    }

    const ok = resultados.filter(r => r.ok);
    const fallidas = resultados.filter(r => r.error && !r.reintentar);
    console.log(`instagram-publicar: ${ok.length} publicadas | ${fallidas.length} con error | ${(trabadas || []).length} trabadas`);

    for (const r of ok) {
      const links = [r.permalink, r.fbPermalink].filter(Boolean).map(l => `\n${esc(l)}`).join('');
      await sendTelegram(`📣 <b>${TIPO_LABEL[r.tipo] || 'Publicación'} publicado en ${nombres(r.redes)}</b>${links}`);
    }
    for (const r of fallidas) {
      const salio = r.salieron && r.salieron.length ? `\nEn ${nombres(r.salieron)} sí salió.` : '';
      await sendTelegram(`❌ <b>No se pudo publicar en ${nombres(r.fallidas)}</b> (#${r.id})\n${esc(r.error)}${salio}`);
    }
    for (const t of trabadas || []) {
      await sendTelegram(`❌ <b>Se cortó mientras se publicaba</b> (#${t.id})\nFijate en Instagram y Facebook si salió antes de reintentar.`);
    }

    return res.json({ ok: true, publicadas: ok.length, fallidas: fallidas.length, trabadas: (trabadas || []).length });
  } catch (err) {
    console.error('Error en instagram-publicar.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.publicarFila = publicarFila;
module.exports.MARGEN_MS = MARGEN_MS;
