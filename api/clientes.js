// api/clientes.js
// GET    /api/clientes        → listar todos con métricas calculadas
// GET    /api/clientes?id=XX  → detalle con historial completo
// POST   /api/clientes        → crear cliente
// PUT    /api/clientes?id=XX  → actualizar cliente
// DELETE /api/clientes?id=XX  → eliminar cliente

const { getSupabase } = require('./_supabase');

function calcularMetricas(ventas) {
  const total_compras = ventas.length;
  const monto_total = ventas.reduce((s, v) => s + (Number(v.total) || 0), 0);
  const ultima_compra = ventas.length
    ? ventas.reduce((max, v) => (v.fecha > max ? v.fecha : max), ventas[0].fecha)
    : null;
  const ticket_promedio = total_compras > 0 ? monto_total / total_compras : 0;
  return { total_compras, monto_total, ultima_compra, ticket_promedio };
}

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
      if (id) {
        // Detalle + historial de compras
        const { data: cliente, error } = await supabase
          .from('clientes').select('*').eq('id', id).single();
        if (error || !cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

        const { data: ventasDirectas } = await supabase
          .from('ventas').select('*').eq('cliente_id', id)
          .order('fecha', { ascending: false });

        let todasVentas = ventasDirectas || [];

        // Auto-link ventas MELI sin cliente_id por meli_nickname
        if (cliente.meli_nickname) {
          const { data: ventasMeli } = await supabase
            .from('ventas').select('*')
            .eq('comprador', cliente.meli_nickname)
            .is('cliente_id', null);
          if (ventasMeli?.length) todasVentas = [...todasVentas, ...ventasMeli];
        }

        todasVentas.sort((a, b) => (b.fecha > a.fecha ? 1 : -1));
        return res.json({ ...cliente, ventas: todasVentas, ...calcularMetricas(todasVentas) });
      }

      // Listado con métricas calculadas
      const [{ data: clientes }, { data: ventas }] = await Promise.all([
        supabase.from('clientes').select('*').order('created_at', { ascending: false }),
        supabase.from('ventas').select('id,total,fecha,cliente_id,comprador'),
      ]);

      const result = (clientes || []).map(c => {
        const cv = (ventas || []).filter(v =>
          v.cliente_id === c.id ||
          (c.meli_nickname && v.comprador === c.meli_nickname)
        );
        return { ...c, ...calcularMetricas(cv) };
      });

      return res.json(result);
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
      const { data, error } = await supabase.from('clientes').insert({
        id: 'CLI' + Date.now(),
        nombre: b.nombre.trim(),
        telefono: b.telefono?.trim() || null,
        email: b.email?.trim() || null,
        canal_origen: b.canal_origen || 'mostrador',
        meli_nickname: b.meli_nickname?.trim() || null,
        notas: b.notas?.trim() || null,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    // ── PUT ──────────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const b = req.body || {};
      if (!b.nombre?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
      const { data, error } = await supabase.from('clientes').update({
        nombre: b.nombre.trim(),
        telefono: b.telefono?.trim() || null,
        email: b.email?.trim() || null,
        canal_origen: b.canal_origen || 'mostrador',
        meli_nickname: b.meli_nickname?.trim() || null,
        notas: b.notas?.trim() || null,
        updated_at: new Date().toISOString(),
      }).eq('id', id).select().single();
      if (error) throw error;
      return res.json(data);
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const { error } = await supabase.from('clientes').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/clientes:', err);
    return res.status(500).json({ error: err.message });
  }
};
