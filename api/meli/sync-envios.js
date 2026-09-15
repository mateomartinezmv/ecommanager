// api/meli/sync-envios.js
// GET /api/meli/sync-envios
//   → Reconciliación de estados de envío contra MELI: recorre los envíos MELI
//     que todavía no llegaron y les aplica el estado real del shipment
//     (pendiente → en camino → entregado), más tracking y fecha de despacho.
//
// El webhook de `shipments` hace esto en tiempo real, pero una notificación
// perdida dejaba el envío congelado para siempre. Este endpoint corre por cron
// y cierra esa ventana.
//
// Parámetros opcionales:
//   ?dias=N   → sólo envíos creados en los últimos N días (default: 45)
//   ?limit=N  → máximo de órdenes a consultar en esta corrida (default: 120)
//   ?dry=1    → muestra qué cambiaría sin tocar la DB

'use strict';

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const {
  obtenerShipment,
  shipmentIdDeOrden,
  sincronizarEnviosDeOrden,
} = require('../_meliEnvios');

// Estados desde los que todavía puede haber novedades. `entregado` es final y
// `problema` se deja quieto: lo revisa una persona.
const ESTADOS_ABIERTOS = ['pendiente', 'en_camino'];

async function sincronizarEnviosMeli({ dias = 45, limit = 120, dryRun = false } = {}) {
  const supabase = getSupabase();
  const token = await getMeliToken();
  const log = [];

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const { data: envios, error } = await supabase
    .from('envios')
    .select('id, orden, estado')
    .like('id', 'E_MELI_%')
    .in('estado', ESTADOS_ABIERTOS)
    .gte('created_at', desde)
    .order('created_at', { ascending: false });

  if (error) throw new Error('Error leyendo envíos: ' + error.message);

  // Una orden con varios ítems tiene varios envíos: se consulta una sola vez.
  const ordenes = [...new Set((envios || []).map(e => e.orden).filter(Boolean))].slice(0, limit);
  log.push(`📦 Envíos abiertos (${dias}d): ${envios?.length || 0} | órdenes a consultar: ${ordenes.length}`);

  const cambios = [];
  let sinCambio = 0, errores = 0, sinShipment = 0;

  for (const orden of ordenes) {
    try {
      const shipmentId = await shipmentIdDeOrden(token, orden);
      if (!shipmentId) {
        log.push(`ℹ Orden ${orden}: sin envío asociado (retiro o acordado)`);
        sinShipment++;
        continue;
      }

      const shipment = await obtenerShipment(token, shipmentId);
      if (!shipment) {
        log.push(`⚠ Orden ${orden}: shipment ${shipmentId} no disponible`);
        errores++;
        continue;
      }

      const aplicados = await sincronizarEnviosDeOrden(supabase, orden, shipment, { dryRun });
      if (aplicados.length === 0) {
        sinCambio++;
        continue;
      }

      for (const c of aplicados) {
        log.push(
          `${dryRun ? '[DRY]' : '🔄'} ${c.id}: ${c.estadoAnterior} → ${c.estado || c.estadoAnterior}` +
          ` | MELI ${shipment.status}/${shipment.substatus || '—'}` +
          (c.tracking ? ` | tracking ${c.tracking}` : '') +
          (c.fecha_despacho ? ` | despacho ${c.fecha_despacho}` : '')
        );
        cambios.push({ orden, ...c });
      }
    } catch (err) {
      log.push(`❌ Orden ${orden}: ${err.message}`);
      errores++;
    }
  }

  log.push(`\n✅ Resumen: ${cambios.length} envíos actualizados | ${sinCambio} sin cambio | ${sinShipment} sin shipment | ${errores} errores`);
  if (dryRun) log.push('⚠ Modo DRY RUN — no se realizaron cambios en la DB');

  return { actualizados: cambios.length, sinCambio, sinShipment, errores, cambios, log };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const dias = parseInt(req.query.dias) || 45;
  const limit = parseInt(req.query.limit) || 120;
  const dryRun = req.query.dry === '1';

  try {
    const r = await sincronizarEnviosMeli({ dias, limit, dryRun });
    return res.json({ ok: true, dryRun, ...r });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
};

module.exports.sincronizarEnviosMeli = sincronizarEnviosMeli;
