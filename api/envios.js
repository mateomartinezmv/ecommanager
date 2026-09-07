// api/envios.js
const { getSupabase } = require('./_supabase');

// Columnas del tarifario UES. Son opcionales: si la migración
// add_ues_shipping_fields todavía no se corrió en Supabase, el guardado se
// reintenta sin ellas en vez de romper el envío entero.
const UES_COLUMNS = ['ues_servicio', 'ues_tramo_kg'];

// Se apaga en cuanto Supabase avisa que las columnas no existen, para no
// reintentar en cada request mientras la migración esté pendiente.
let uesColumnsDisponibles = true;

function esColumnaUESFaltante(error) {
  const msg = (error && error.message) || '';
  return UES_COLUMNS.some(col => msg.includes(col));
}

function sinColumnasUES(payload) {
  const out = { ...payload };
  UES_COLUMNS.forEach(col => delete out[col]);
  return out;
}

// Ejecuta una escritura sobre `envios` y, si falla solo por las columnas UES,
// la reintenta sin ellas.
async function escribirEnvio(ejecutar, payload) {
  const primerIntento = uesColumnsDisponibles ? payload : sinColumnasUES(payload);
  let { data, error } = await ejecutar(primerIntento);
  if (error && uesColumnsDisponibles && esColumnaUESFaltante(error)) {
    console.warn('Columnas UES ausentes en la tabla envios: se guarda sin ellas. ' +
      'Corré la migración supabase/migrations/20260907000000_add_ues_shipping_fields.sql');
    uesColumnsDisponibles = false;
    ({ data, error } = await ejecutar(sinColumnasUES(payload)));
  }
  if (error) throw error;
  return data;
}

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
      const payload = {
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
      };
      // Solo se mandan si el envío es UES; el resto de los transportistas
      // ni toca estas columnas.
      if (e.uesServicio) payload.ues_servicio = e.uesServicio;
      if (e.uesTramoKg != null) payload.ues_tramo_kg = e.uesTramoKg;
      const data = await escribirEnvio(
        p => supabase.from('envios').insert(p).select().single(), payload);
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      const { estado, tracking, costo, zona, colecta, transportista, comprador, fechaDespacho, direccion,
              uesServicio, uesTramoKg } = req.body;
      const updateData = { estado, tracking };
      if (costo !== undefined) updateData.costo = costo;
      if (zona !== undefined) updateData.zona = zona;
      if (colecta !== undefined) updateData.colecta = colecta;
      if (transportista !== undefined) updateData.transportista = transportista;
      if (comprador !== undefined) updateData.comprador = comprador;
      if (fechaDespacho !== undefined) updateData.fecha_despacho = fechaDespacho || null;
      if (direccion !== undefined) updateData.direccion = direccion;
      // Igual que en el POST: solo se escriben cuando el envío es UES, así una
      // edición de otro transportista nunca toca estas columnas.
      if (uesServicio) updateData.ues_servicio = uesServicio;
      if (uesTramoKg != null) updateData.ues_tramo_kg = uesTramoKg;
      const data = await escribirEnvio(
        p => supabase.from('envios').update(p).eq('id', id).select().single(), updateData);
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
