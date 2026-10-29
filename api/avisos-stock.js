// api/avisos-stock.js
// Waitlist: clientes que esperan que vuelva a entrar un producto.
//
// GET    /api/avisos-stock               → { avisos, migracionPendiente }
// POST   /api/avisos-stock               → anotar a un cliente { cliente_id, sku, cantidad, nota }
// PUT    /api/avisos-stock?id=AVI123     → cambiar estado ('avisado' | 'cancelado')
//
// El paso a 'listo' no se hace acá: lo hace /api/importaciones cuando llega una importación
// que trae el SKU (ver api/_avisosStock.js).

const { getSupabase } = require('./_supabase');
const { faltaMigracionAvisos } = require('./_avisosStock');

const MIGRACION = 'supabase/migrations/20261029000000_add_avisos_stock.sql';
// Lo que se puede poner a mano. 'listo' lo pone la llegada de una importación y
// 'esperando' es el estado con el que nace.
const ESTADOS_MANUALES = ['avisado', 'cancelado'];

function errorMigracion(res) {
  return res.status(503).json({ error: `Falta correr la migración ${MIGRACION} en Supabase.`, migracionPendiente: true });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const id = req.query.id;

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    // Sin la tabla responde vacío y avisa: el resto del CRM no puede romperse por esto.
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('avisos_stock').select('*').order('created_at', { ascending: false });
      if (error) {
        if (faltaMigracionAvisos(error)) return res.json({ avisos: [], migracionPendiente: true });
        throw error;
      }
      return res.json({ avisos: data || [], migracionPendiente: false });
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      const clienteId = String(b.cliente_id || '').trim();
      const sku = String(b.sku || '').trim();
      if (!clienteId) return res.status(400).json({ error: 'Falta el cliente' });
      if (!sku) return res.status(400).json({ error: 'Falta el SKU' });
      const cantidad = Math.floor(Number(b.cantidad));

      const { data: producto } = await supabase.from('productos').select('sku').eq('sku', sku).single();
      if (!producto) return res.status(400).json({ error: `No existe un producto con SKU ${sku}` });

      const fila = {
        id: 'AVI' + Date.now(),
        cliente_id: clienteId,
        sku,
        cantidad: Number.isFinite(cantidad) && cantidad >= 1 ? cantidad : 1,
        nota: String(b.nota || '').trim() || null,
        estado: 'esperando',
      };
      const { data, error } = await supabase.from('avisos_stock').insert(fila).select().single();
      if (error) {
        if (faltaMigracionAvisos(error)) return errorMigracion(res);
        // Índice único avisos_stock_abierto_unico: ya hay un aviso abierto de ese cliente y SKU.
        if (error.code === '23505') return res.status(409).json({ error: `Este cliente ya está esperando ${sku}` });
        throw error;
      }
      return res.json(data);
    }

    // ── PUT ──────────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Falta ?id=' });
      const estado = String((req.body || {}).estado || '');
      if (!ESTADOS_MANUALES.includes(estado)) {
        return res.status(400).json({ error: `Estado inválido: tiene que ser ${ESTADOS_MANUALES.join(' o ')}` });
      }
      const campos = { estado };
      if (estado === 'avisado') campos.avisado_at = new Date().toISOString();
      const { data, error } = await supabase
        .from('avisos_stock').update(campos).eq('id', id).select().single();
      if (error) {
        if (faltaMigracionAvisos(error)) return errorMigracion(res);
        throw error;
      }
      return res.json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/avisos-stock:', err);
    return res.status(500).json({ error: err.message });
  }
};
