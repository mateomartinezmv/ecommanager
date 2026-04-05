// api/transportistas.js
// GET  /api/transportistas → deuda por transportista + historial de pagos
// POST /api/transportistas → registrar pago
// DELETE /api/transportistas?id=XX → eliminar pago

const { getSupabase } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    if (req.method === 'GET') {
      // Obtener envíos no pagados con costo > 0
      const { data: envios, error: enviosErr } = await supabase
        .from('envios')
        .select('transportista, costo, colecta, estado, pagado')
        .eq('pagado', false)
        .gt('costo', 0);
      if (enviosErr) throw enviosErr;

      // Calcular deuda por transportista (costo + colecta si aplica)
      const deudas = {};
      for (const e of envios || []) {
        const t = e.transportista || 'otro';
        const costoReal = (e.costo || 0) + (e.colecta ? 75 : 0);
        if (!deudas[t]) deudas[t] = 0;
        deudas[t] += costoReal;
      }

      // Obtener historial de pagos
      const { data: pagos, error: pagosErr } = await supabase
        .from('pagos_transportistas')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (pagosErr) throw pagosErr;

      return res.json({ deudas, pagos: pagos || [] });
    }

    if (req.method === 'POST') {
      const { transportista, monto, fecha, notas } = req.body;
      if (!transportista || !monto) {
        return res.status(400).json({ error: 'Faltan transportista y monto' });
      }

      // Registrar el pago
      const id = 'PAG-' + Date.now();
      const { data: pago, error: pagoErr } = await supabase
        .from('pagos_transportistas')
        .insert({ id, transportista, monto, fecha: fecha || new Date().toISOString().slice(0,10), notas })
        .select().single();
      if (pagoErr) throw pagoErr;

      // Marcar envíos de ese transportista como pagados (de más antiguo a más nuevo)
      // hasta cubrir el monto pagado
      const { data: enviosPendientes } = await supabase
        .from('envios')
        .select('id, costo, colecta')
        .eq('transportista', transportista)
        .eq('pagado', false)
        .or('costo.gt.0,colecta.eq.true')
        .order('created_at', { ascending: true });

      let restante = monto;
      const idsAPagar = [];
      for (const e of enviosPendientes || []) {
        const costoReal = (e.costo || 0) + (e.colecta ? 75 : 0);
        if (restante >= costoReal) {
          idsAPagar.push(e.id);
          restante -= costoReal;
        }
      }

      if (idsAPagar.length > 0) {
        await supabase.from('envios').update({ pagado: true }).in('id', idsAPagar);
      }

      return res.json({ ok: true, pago, envios_marcados: idsAPagar.length, restante_sin_asignar: restante });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      const { error } = await supabase.from('pagos_transportistas').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/transportistas:', err);
    res.status(500).json({ error: err.message });
  }
};
