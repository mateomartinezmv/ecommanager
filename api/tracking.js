// api/tracking.js
// GET    /api/tracking                         → { trackings, migracionPendiente }
// POST   /api/tracking                         → cargar un contenedor (y consultarlo en la naviera)
// PUT    /api/tracking?id=XX                   → editar datos o las PIs que vienen adentro
// POST   /api/tracking?accion=actualizar&id=XX → volver a consultar la naviera ahora
// DELETE /api/tracking?id=XX                   → borrar (las importaciones no se tocan)
//
// Cada alta, edición o consulta lleva el arribo del contenedor a la `llegada` de sus
// importaciones (ver api/_tracking.js). La respuesta trae `importaciones_sync` con lo que se
// movió y, si se consultó la naviera, `consulta: { error }`.

const { getSupabase } = require('./_supabase');
const T = require('../public/tracking-contenedores');
const {
  MSG_MIGRACION, faltaMigracionTracking, normalizarTracking, completarLlegadasCalculadas,
  historialEta, actualizarDesdeNaviera, sincronizarSeguro,
} = require('./_tracking');

const MSG_CONTENEDOR = 'El número de contenedor son 4 letras y 7 números (ej: PCIU 891912-8).';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const id = req.query.id;
  const ahora = new Date().toISOString();
  // Sin la tabla, un 409 que dice qué migración correr; cualquier otro error sigue de largo.
  const fallar = error => {
    if (faltaMigracionTracking(error)) { const e = new Error(MSG_MIGRACION); e.status = 409; throw e; }
    if (error?.code === 'PGRST116') { const e = new Error('No existe ese contenedor'); e.status = 404; throw e; }
    throw error;
  };

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('trackings').select('*').order('created_at', { ascending: false });
      // Sin la tabla, la pantalla tiene que cargar igual y explicar qué falta.
      if (error && faltaMigracionTracking(error)) return res.json({ trackings: [], migracionPendiente: true });
      if (error) throw error;
      return res.json({ trackings: data || [], migracionPendiente: false });
    }

    // ── Volver a consultar la naviera ────────────────────────────────────────
    if (req.method === 'POST' && req.query.accion === 'actualizar') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const { data: actual, error } = await supabase.from('trackings').select('*').eq('id', id).single();
      if (error) fallar(error);
      if (!T.navieraAutomatica(actual.naviera)) {
        return res.status(400).json({ error: `${T.naviera(actual.naviera).nombre} no se consulta sola: cargá el arribo a mano con ✏️ Editar.` });
      }
      const r = await actualizarDesdeNaviera(supabase, actual, { ahora });
      const sync = await sincronizarSeguro(supabase, r.tracking);
      return res.json({ ...r.tracking, consulta: { error: r.error, novedades: r.novedades }, importaciones_sync: sync });
    }

    // ── Alta ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      const fila = normalizarTracking(b);
      if (!T.formatoContenedorValido(fila.contenedor)) return res.status(400).json({ error: MSG_CONTENEDOR });
      fila.id = 'TRK' + Date.now();
      fila.importaciones = await completarLlegadasCalculadas(supabase, fila.importaciones, []);
      Object.assign(fila, historialEta(null, fila.eta, 'manual', ahora));

      const { data: creado, error } = await supabase.from('trackings').insert(fila).select().single();
      if (error) fallar(error);

      let tracking = creado;
      let consulta = null;
      if (T.navieraAutomatica(tracking.naviera) && b.consultar !== false) {
        const r = await actualizarDesdeNaviera(supabase, tracking, { ahora });
        tracking = r.tracking;
        consulta = { error: r.error, novedades: r.novedades };
      }
      const sync = await sincronizarSeguro(supabase, tracking);
      return res.json({ ...tracking, consulta, importaciones_sync: sync });
    }

    // ── Edición ──────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const b = req.body || {};
      const { data: actual, error: errActual } = await supabase.from('trackings').select('*').eq('id', id).single();
      if (errActual) fallar(errActual);

      const fila = normalizarTracking(b, { parcial: true });
      if ('contenedor' in fila && !T.formatoContenedorValido(fila.contenedor)) return res.status(400).json({ error: MSG_CONTENEDOR });
      if (fila.importaciones) fila.importaciones = await completarLlegadasCalculadas(supabase, fila.importaciones, actual.importaciones);
      if ('eta' in fila) Object.assign(fila, historialEta(actual, fila.eta, 'manual', ahora));
      fila.updated_at = ahora;

      const { data: guardado, error } = await supabase.from('trackings').update(fila).eq('id', id).select().single();
      if (error) throw error;

      // Otro número u otra naviera: lo de antes ya no vale, se vuelve a consultar.
      let tracking = guardado;
      let consulta = null;
      const cambioRef = guardado.contenedor !== actual.contenedor || guardado.naviera !== actual.naviera;
      if (T.navieraAutomatica(tracking.naviera) && (cambioRef || b.consultar === true)) {
        const r = await actualizarDesdeNaviera(supabase, tracking, { ahora });
        tracking = r.tracking;
        consulta = { error: r.error, novedades: r.novedades };
      }
      const sync = await sincronizarSeguro(supabase, tracking);
      return res.json({ ...tracking, consulta, importaciones_sync: sync });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const { error } = await supabase.from('trackings').delete().eq('id', id);
      if (error) fallar(error);
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (!err.status) console.error('Error en /api/tracking:', err);
    return res.status(err.status || 500).json({ error: err.message });
  }
};
