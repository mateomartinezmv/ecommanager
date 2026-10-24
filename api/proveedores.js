// api/proveedores.js
// GET    /api/proveedores                   → { proveedores, migracionPendiente }
// POST   /api/proveedores                   → crear proveedor
// PUT    /api/proveedores?id=XX             → actualizar datos
// DELETE /api/proveedores?id=XX             → eliminar (importaciones y productos quedan sin asignar)
// POST   /api/proveedores?accion=asignar    → { proveedor_id, skus } asigna (o quita, con
//                                              proveedor_id null) el proveedor de esos productos

const { getSupabase } = require('./_supabase');
const { normalizarProveedor, faltaMigracionProveedores } = require('./_proveedores');

const MSG_MIGRACION = 'Falta correr la migración supabase/migrations/20261024000000_add_proveedores.sql en Supabase.';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const id = req.query.id;

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('proveedores')
        .select('*')
        .order('nombre', { ascending: true });
      // Sin la tabla, la pantalla tiene que poder cargar igual y explicar qué falta.
      if (error && faltaMigracionProveedores(error)) return res.json({ proveedores: [], migracionPendiente: true });
      if (error) throw error;
      return res.json({ proveedores: data || [], migracionPendiente: false });
    }

    if (req.method === 'POST' && req.query.accion === 'asignar') {
      const b = req.body || {};
      const skus = [...new Set((Array.isArray(b.skus) ? b.skus : []).map(s => String(s || '').trim()).filter(Boolean))];
      if (!skus.length) return res.status(400).json({ error: 'No hay productos para asignar' });
      const { data, error } = await supabase
        .from('productos')
        .update({ proveedor_id: b.proveedor_id || null })
        .in('sku', skus)
        .select('sku, proveedor_id');
      if (error && faltaMigracionProveedores(error)) return res.status(409).json({ error: MSG_MIGRACION });
      if (error) throw error;
      return res.json({ ok: true, actualizados: data || [] });
    }

    if (req.method === 'POST') {
      const fila = normalizarProveedor(req.body);
      if (!fila.nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
      const { data, error } = await supabase
        .from('proveedores')
        .insert({ id: 'PROV-' + Date.now(), ...fila })
        .select().single();
      if (error && faltaMigracionProveedores(error)) return res.status(409).json({ error: MSG_MIGRACION });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const fila = normalizarProveedor(req.body, { parcial: true });
      if ('nombre' in fila && !fila.nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
      const { data, error } = await supabase
        .from('proveedores').update(fila).eq('id', id).select().single();
      if (error && faltaMigracionProveedores(error)) return res.status(409).json({ error: MSG_MIGRACION });
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const { error } = await supabase.from('proveedores').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/proveedores:', err);
    return res.status(500).json({ error: err.message });
  }
};
