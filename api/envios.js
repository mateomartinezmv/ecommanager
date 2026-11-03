// api/envios.js
// GET    /api/envios                        → todos los envíos
// GET    /api/envios?buscar=CODIGO          → el envío de una etiqueta de MELI escaneada (control de despacho)
// GET    /api/envios?fotos=MLU1,MLU2        → { fotos: { MLU1: url } } para la pantalla de control
// POST   /api/envios                        → alta
// PUT    /api/envios?id=X                   → edición (incluye el resultado del control de despacho)
// DELETE /api/envios?id=X
const { getSupabase } = require('./_supabase');
const { getMeliToken } = require('./_meliToken');
const { MIGRACION, MIGRACION_ETIQUETA, faltaMigracionControl, buscarEnvioPorCodigo, fotosDePublicaciones, camposControl } = require('./_controlEnvios');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  try {
    if (req.method === 'GET' && req.query.buscar !== undefined) {
      const r = await buscarEnvioPorCodigo(supabase, getMeliToken, String(req.query.buscar));
      if (!r) return res.status(404).json({ error: 'No hay ningún envío del CRM con ese código.' });
      return res.json(r);
    }

    if (req.method === 'GET' && req.query.fotos !== undefined) {
      const ids = String(req.query.fotos).split(',');
      const fotos = await fotosDePublicaciones(await getMeliToken(), ids);
      return res.json({ fotos });
    }

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
        zona: e.zona || null,
        colecta: e.colecta || false,
      }).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      const { estado, tracking, costo, zona, colecta, transportista, comprador, fechaDespacho, direccion } = req.body;
      // Sólo lo que viene: renombrar el destinatario desde la venta no toca estado ni tracking.
      const updateData = {};
      if (estado !== undefined) updateData.estado = estado;
      if (tracking !== undefined) updateData.tracking = tracking;
      if (costo !== undefined) updateData.costo = costo;
      if (zona !== undefined) updateData.zona = zona;
      if (colecta !== undefined) updateData.colecta = colecta;
      if (transportista !== undefined) updateData.transportista = transportista;
      if (comprador !== undefined) updateData.comprador = comprador;
      if (fechaDespacho !== undefined) updateData.fecha_despacho = fechaDespacho || null;
      if (direccion !== undefined) updateData.direccion = direccion;
      Object.assign(updateData, camposControl(req.body));
      const { data, error } = await supabase.from('envios')
        .update(updateData)
        .eq('id', id).select().single();
      if (error && faltaMigracionControl(error)) {
        // La etiqueta impresa se manda sola: si falla, es por su propia migración.
        const migracion = updateData.etiqueta_impresa_at !== undefined ? MIGRACION_ETIQUETA : MIGRACION;
        return res.status(503).json({ error: `Falta correr la migración ${migracion} en Supabase.`, migracionPendiente: true });
      }
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
