// api/importaciones.js
// GET    /api/importaciones        → listar todas
// POST   /api/importaciones        → crear importación
// PUT    /api/importaciones?id=XX  → actualizar estado/notas
// DELETE /api/importaciones?id=XX  → eliminar

const { getSupabase } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const id = req.query.id;

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('importaciones')
        .select('*')
        .order('fecha', { ascending: false });
      if (error) throw error;
      return res.json(data || []);
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.fecha) return res.status(400).json({ error: 'La fecha es obligatoria' });

      const traslado = Number(b.traslado) || 0;
      const nacional = Number(b.nacional) || 0;
      const items    = Array.isArray(b.items) ? b.items : [];
      // Cálculo inverso: el usuario ingresa el total que ya incluye IVA
      const total    = Number(b.total) || 0;
      const subtotal = total / 1.22;   // base imponible
      const iva      = total - subtotal;

      const { data, error } = await supabase.from('importaciones').insert({
        id:       'IMP' + Date.now(),
        fecha:    b.fecha,
        llegada:  b.llegada || null,
        estado:   b.estado || 'en_transito',
        notas:    b.notas?.trim() || null,
        items,
        traslado,
        nacional,
        subtotal,
        iva,
        total,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    // ── PUT ──────────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const b = req.body || {};
      const { data, error } = await supabase.from('importaciones').update({
        estado:  b.estado,
        notas:   b.notas?.trim() || null,
        llegada: b.llegada || null,
      }).eq('id', id).select().single();
      if (error) throw error;
      return res.json(data);
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const { error } = await supabase.from('importaciones').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/importaciones:', err);
    return res.status(500).json({ error: err.message });
  }
};
