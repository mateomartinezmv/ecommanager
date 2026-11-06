// api/cron/instagram-publicar.js
// Cron — cada 5 minutos.
//
// Publica en Instagram lo que está programado en instagram_publicaciones y ya llegó su hora.
// La API de Meta no programa publicaciones: publica en el momento, así que el horario lo
// cumple este cron (con hasta 5 minutos de atraso).
//
// Para no publicar dos veces lo mismo, cada fila se "toma" pasándola de 'programado' a
// 'publicando' con un UPDATE condicionado: si el cron y el botón "Publicar ahora" del CRM
// corren a la vez, solo uno de los dos la consigue. Una fila que quedó en 'publicando' más
// de 15 minutos (se cortó la función a mitad de camino) no se reintenta sola, porque pudo
// haber salido: se marca con error para que alguien mire Instagram antes de reintentar.
//
// Avisa por WhatsApp (Telegram de respaldo) cada publicación que sale y cada una que falla.

const { getSupabase } = require('../_supabase');
const { publicar } = require('../_metaInstagram');

const POR_VUELTA = 5;
const TRABADA_MS = 15 * 60 * 1000;
// "Instagram sigue procesando la imagen" no es un error de la publicación: se vuelve a
// intentar en las próximas vueltas antes de darla por fallida.
const MAX_INTENTOS_PROCESANDO = 3;

const { enviarAviso: sendTelegram } = require('../_aviso');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TIPO_LABEL = { post: 'Post', carrusel: 'Carrusel', historia: 'Historia' };

// Toma la fila (si sigue en alguno de los estados de `desde`) y la publica.
// Devuelve null si no se pudo tomar, { ok, permalink } si salió o { error } si falló.
// `fetchImpl` y `espera` son para los tests.
async function publicarFila(supabase, id, { desde = ['programado'], fetchImpl, espera } = {}) {
  const { data: tomadas, error: errTomar } = await supabase.from('instagram_publicaciones')
    .update({ estado: 'publicando', publicando_desde: new Date().toISOString() })
    .eq('id', id).in('estado', desde)
    .select();
  if (errTomar) throw errTomar;
  const pub = tomadas && tomadas[0];
  if (!pub) return null;
  const intentos = (pub.intentos || 0) + 1;

  try {
    const { data: cuenta } = await supabase.from('meta_tokens').select('*').eq('id', 1).maybeSingle();
    const { mediaId, permalink } = await publicar(pub, cuenta, { ...(fetchImpl && { fetchImpl }), espera });
    await supabase.from('instagram_publicaciones').update({
      estado: 'publicado',
      ig_media_id: mediaId,
      permalink,
      publicado_at: new Date().toISOString(),
      intentos,
      error: null,
    }).eq('id', id);
    return { ok: true, id, tipo: pub.tipo, permalink };
  } catch (err) {
    const procesando = /sigue procesando/i.test(err.message);
    const reintentar = procesando && intentos < MAX_INTENTOS_PROCESANDO;
    await supabase.from('instagram_publicaciones').update({
      estado: reintentar ? 'programado' : 'error',
      intentos,
      error: err.message,
    }).eq('id', id);
    return { error: err.message, id, tipo: pub.tipo, reintentar };
  }
}

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
      .update({ estado: 'error', error: 'Se cortó mientras se publicaba. Fijate en Instagram si salió antes de reintentar.' })
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

    const resultados = [];
    for (const { id } of vencidas || []) {
      const r = await publicarFila(supabase, id);
      if (r) resultados.push(r);
    }

    const ok = resultados.filter(r => r.ok);
    const fallidas = resultados.filter(r => r.error && !r.reintentar);
    console.log(`instagram-publicar: ${ok.length} publicadas | ${fallidas.length} con error | ${(trabadas || []).length} trabadas`);

    for (const r of ok) {
      await sendTelegram(`📸 <b>${TIPO_LABEL[r.tipo] || 'Publicación'} publicado en Instagram</b>${r.permalink ? `\n${esc(r.permalink)}` : ''}`);
    }
    for (const r of [...fallidas, ...(trabadas || []).map(t => ({ ...t, error: 'Se cortó mientras se publicaba' }))]) {
      await sendTelegram(`❌ <b>No se pudo publicar en Instagram</b> (#${r.id})\n${esc(r.error)}`);
    }

    return res.json({ ok: true, publicadas: ok.length, fallidas: fallidas.length, trabadas: (trabadas || []).length });
  } catch (err) {
    console.error('Error en instagram-publicar.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.publicarFila = publicarFila;
