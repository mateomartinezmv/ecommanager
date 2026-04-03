// api/importaciones.js
// GET    /api/importaciones         → list all imports with their items
// POST   /api/importaciones         → create new import + line items
// PUT    /api/importaciones?id=XX   → update import (status, actual_arrival_date, etc.)
// DELETE /api/importaciones?id=XX   → delete import (cascades to items)

const { getSupabase } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    // ── GET ─────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('imports')
        .select('*, import_items(*)')
        .order('order_date', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { items, ...importData } = req.body;
      const lineItems = Array.isArray(items) ? items : [];

      const totalItems = lineItems.reduce((sum, i) => sum + (Number(i.quantity_ordered) || 0), 0);

      const { data: importRecord, error: importErr } = await supabase
        .from('imports')
        .insert([{
          order_date:            importData.order_date,
          estimated_arrival_date: importData.estimated_arrival_date || null,
          status:                importData.status || 'ordered',
          notes:                 importData.notes  || null,
          total_items:           totalItems,
        }])
        .select()
        .single();
      if (importErr) throw importErr;

      if (lineItems.length > 0) {
        const rows = lineItems.map(i => ({
          import_id:        importRecord.id,
          sku:              i.sku,
          product_name:     i.product_name,
          quantity_ordered: Number(i.quantity_ordered),
          unit_cost:        i.unit_cost != null ? Number(i.unit_cost) : null,
          currency:         i.currency || 'USD',
        }));
        const { error: itemsErr } = await supabase.from('import_items').insert(rows);
        if (itemsErr) throw itemsErr;
      }

      // Return full record with items
      const { data: full, error: fullErr } = await supabase
        .from('imports')
        .select('*, import_items(*)')
        .eq('id', importRecord.id)
        .single();
      if (fullErr) throw fullErr;
      return res.status(201).json(full);
    }

    // ── PUT ──────────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });

      const updates = req.body;
      const allowed = ['status', 'actual_arrival_date', 'estimated_arrival_date', 'notes', 'total_items'];
      const patch = {};
      for (const k of allowed) {
        if (updates[k] !== undefined) patch[k] = updates[k];
      }

      const { data, error } = await supabase
        .from('imports')
        .update(patch)
        .eq('id', id)
        .select('*, import_items(*)')
        .single();
      if (error) throw error;
      return res.json(data);
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      // import_items rows are removed by ON DELETE CASCADE
      const { error } = await supabase.from('imports').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/importaciones:', err);
    return res.status(500).json({ error: err.message });
  }
};
