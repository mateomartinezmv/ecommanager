// api/meta/instagram.js
// Publicaciones de Instagram y Facebook: programarlas, publicarlas ya y cancelarlas.
//
//   GET    /api/meta/instagram                         → { cuenta, publicaciones }
//   POST   /api/meta/instagram                         → programar { tipo, redes, imagenes, caption, programadoPara, notas }
//                                                        (sin `redes` sale en Instagram y Facebook)
//   POST   /api/meta/instagram?accion=publicar&id=12   → publicar ahora una programada (o reintentar una que falló)
//   DELETE /api/meta/instagram?id=12                   → cancelar (solo si todavía no salió)
//
// Lo programado lo publica el cron api/cron/instagram-publicar.js cuando llega la hora.

const { getSupabase } = require('../_supabase');
const { armarPublicacion } = require('../_metaInstagram');
const { publicarFila, MARGEN_MS } = require('../cron/instagram-publicar');

// Postgres responde 42P01 cuando la tabla no existe: la migración todavía no se corrió.
const faltaMigracion = err => err && (err.code === '42P01' || /does not exist|schema cache/i.test(err.message || ''));
const AVISO_MIGRACION = 'Falta correr la migración de Instagram en Supabase (supabase/migrations/20261105010000_add_instagram.sql).';

module.exports = async (req, res) => {
  const supabase = getSupabase();
  const { id, accion } = req.query;

  try {
    if (req.method === 'GET') {
      const [{ data: cuenta, error: errCuenta }, { data: publicaciones, error: errPubs }] = await Promise.all([
        supabase.from('meta_tokens').select('page_name, ig_user_id, ig_username, updated_at').eq('id', 1).maybeSingle(),
        supabase.from('instagram_publicaciones').select('*').order('programado_para', { ascending: false }).limit(200),
      ]);
      const err = errCuenta || errPubs;
      if (faltaMigracion(err)) return res.json({ cuenta: null, publicaciones: [], faltaMigracion: true, aviso: AVISO_MIGRACION });
      if (err) throw err;
      return res.json({ cuenta: cuenta && cuenta.ig_user_id ? cuenta : null, publicaciones: publicaciones || [] });
    }

    if (req.method === 'POST' && accion === 'publicar') {
      if (!id) return res.status(400).json({ error: 'Falta el id' });
      // Mismo camino que el cron: toma la fila solo si sigue programada, así no sale dos veces.
      // Con el mismo margen que el cron: si no llega a todas las redes, el resto lo publica el
      // cron en su próxima vuelta (la fila vuelve a 'programado').
      const r = await publicarFila(supabase, Number(id), { desde: ['programado', 'error'], hasta: Date.now() + MARGEN_MS });
      if (!r) return res.status(409).json({ error: 'Esa publicación ya no se puede publicar (salió, se canceló o se está publicando)' });
      if (r.error) return res.status(502).json({ error: r.error });
      return res.json(r);
    }

    if (req.method === 'POST') {
      const { publicacion, error } = armarPublicacion(req.body || {});
      if (error) return res.status(400).json({ error });
      const { data, error: dbErr } = await supabase.from('instagram_publicaciones').insert(publicacion).select().single();
      if (faltaMigracion(dbErr)) return res.status(500).json({ error: AVISO_MIGRACION });
      if (dbErr) throw dbErr;
      return res.json(data);
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Falta el id' });
      const { data, error } = await supabase.from('instagram_publicaciones')
        .update({ estado: 'cancelado' })
        .eq('id', Number(id)).in('estado', ['programado', 'error'])
        .select();
      if (error) throw error;
      if (!data.length) return res.status(409).json({ error: 'Solo se puede cancelar una publicación que todavía no salió' });
      return res.json(data[0]);
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en meta/instagram.js:', err);
    return res.status(500).json({ error: err.message });
  }
};
