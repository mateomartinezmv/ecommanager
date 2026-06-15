// api/meli/actualizar-envios.js
// GET /api/meli/actualizar-envios
//   → Re-consulta la API de MELI para cada envío existente y corrige
//     el transportista (mercado_envios ↔ gestionpost) según el logistic_type real.
//
// Parámetros opcionales:
//   ?dias=N   → solo órdenes de los últimos N días (default: 30)
//   ?dry=1    → modo dry-run: muestra qué cambiaría sin modificar nada

'use strict';

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

const FLEX_TYPES = ['self_service', 'self_service_flex'];

const { detectarZona, detectarZonaDesdeShipData, COSTOS_ENVIOSUY } = require('../_flexZonas');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const dias = parseInt(req.query.dias) || 30;
  const limit = parseInt(req.query.limit) || 0; // 0 = sin límite
  const dryRun = req.query.dry === '1';
  const supabase = getSupabase();
  const log = [];

  try {
    const token = await getMeliToken();
    log.push(`✅ Token OK | dry=${dryRun} | dias=${dias} | limit=${limit || 'sin límite'}`);

    // Traer envíos de los últimos N días vinculados a órdenes MELI
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: envios, error: enviosErr } = await supabase
      .from('envios')
      .select('id, orden, transportista, costo, direccion')
      .like('id', 'E_MELI_%')
      .gte('created_at', desde)
      .order('created_at', { ascending: false });

    if (enviosErr) throw new Error('Error leyendo envíos: ' + enviosErr.message);
    const enviosFiltrados = limit > 0 ? envios.slice(0, limit) : envios;
    log.push(`📦 Envíos MELI en últimos ${dias} días: ${envios.length} | procesando: ${enviosFiltrados.length}`);

    const resultados = [];
    let actualizados = 0, sinCambio = 0, errores = 0;

    for (const envio of enviosFiltrados) {
      const ordenId = envio.orden;
      if (!ordenId) { errores++; continue; }

      try {
        // Obtener detalle de la orden para encontrar el shipping_id
        const orderRes = await fetch(`https://api.mercadolibre.com/orders/${ordenId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const order = await orderRes.json();
        if (order.error) {
          log.push(`⚠ Orden ${ordenId}: ${order.message}`);
          errores++;
          continue;
        }

        const shippingId = order.shipping?.id;
        if (!shippingId) {
          log.push(`ℹ Orden ${ordenId}: sin shipping_id (retiro)`);
          sinCambio++;
          continue;
        }

        // Obtener datos del shipment
        const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const shipData = await shipRes.json();
        const logisticType = shipData?.logistic_type || '';
        const esFlex = FLEX_TYPES.includes(logisticType);

        // Recalcular dirección incluyendo barrio (campo estructurado de MELI)
        let direccion = envio.direccion;
        if (!direccion && shipData?.receiver_address) {
          const addr = shipData.receiver_address;
          const neighborhood = addr.neighborhood?.name || '';
          direccion = [addr.street_name, addr.street_number, neighborhood, addr.city?.name, addr.state?.name].filter(Boolean).join(', ');
        }

        let transportistaCorrecto, costoCorrecto, zona;
        if (esFlex) {
          // Usar datos estructurados de MELI para detección de zona
          zona = detectarZonaDesdeShipData(shipData);
          // Fallback a dirección si no se detectó por datos del shipment
          if (!zona && direccion) zona = detectarZona(direccion);
          transportistaCorrecto = 'enviosuy';
          costoCorrecto = zona ? (COSTOS_ENVIOSUY[zona] ?? 0) : 0;
        } else {
          transportistaCorrecto = 'mercado_envios';
          costoCorrecto = 0;
        }

        const hayCambioTransportista = envio.transportista !== transportistaCorrecto;
        const hayCambioDir = !envio.direccion && direccion;

        if (!hayCambioTransportista && !hayCambioDir) {
          sinCambio++;
          continue;
        }

        log.push(`${dryRun ? '[DRY]' : '🔄'} ${envio.id}: ${envio.transportista} → ${transportistaCorrecto} | logistic="${logisticType}" | zona ${zona || 'N/D'} | costo $${costoCorrecto}`);

        if (!dryRun) {
          const update = { transportista: transportistaCorrecto, costo: costoCorrecto, zona: zona || null };
          if (hayCambioDir) update.direccion = direccion;
          await supabase.from('envios').update(update).eq('id', envio.id);
        }
        resultados.push({ id: envio.id, orden: ordenId, logisticType, transportistaCorrecto, zona, costo: costoCorrecto });
        actualizados++;
      } catch (err) {
        log.push(`❌ Error procesando envío ${envio.id}: ${err.message}`);
        errores++;
      }
    }

    log.push(`\n✅ Resumen: ${actualizados} actualizados | ${sinCambio} sin cambio | ${errores} errores`);
    if (dryRun) log.push('⚠ Modo DRY RUN — no se realizaron cambios en la DB');

    return res.json({ ok: true, dryRun, actualizados, sinCambio, errores, log, resultados });
  } catch (err) {
    return res.json({ ok: false, log, error: err.message });
  }
};
