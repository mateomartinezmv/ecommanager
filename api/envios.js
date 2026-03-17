// api/envios.js
const { getSupabase } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('envios')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'POST') {
      const e = req.body;
      const { data, error } = await supabase.from('envios').insert({
        id: e.id,
        venta_id: e.ventaId || null,
        orden: e.orden || null,
        comprador: e.comprador || null,
        producto: e.producto || null,
        transportista: e.transportista,
        tracking: e.tracking || null,
        fecha_despacho: e.fechaDespacho || null,
        estado: e.estado || 'pendiente',
        direccion: e.direccion || null,
        costo: e.costo || 0,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      const { estado, tracking, costo, colecta, transportista, comprador, fechaDespacho, direccion } = req.body;
      const updateData = { estado, tracking };
      if (costo !== undefined) updateData.costo = costo;
      if (colecta !== undefined) updateData.colecta = colecta;
      if (transportista !== undefined) updateData.transportista = transportista;
      if (comprador !== undefined) updateData.comprador = comprador;
      if (fechaDespacho !== undefined) updateData.fecha_despacho = fechaDespacho || null;
      if (direccion !== undefined) updateData.direccion = direccion;
      const { data, error } = await supabase.from('envios')
        .update(updateData)
        .eq('id', id).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      const { error } = await supabase.from('envios').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/envios:', err);
    res.status(500).json({ error: err.message });
  }
};
