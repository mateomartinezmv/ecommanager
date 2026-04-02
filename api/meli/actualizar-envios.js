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

const ZONAS_KEYWORDS = {
  1: ['pajas blancas', 'santiago vazquez', 'paso de la arena', 'ciudad del plata'],
  2: ['la paz', 'colon', 'lezica', 'abayuba', 'jardines del hipodromo'],
  3: ['toledo', 'manga', 'piedras blancas', 'flor de maronas', 'maronas', 'ituzaingo'],
  4: ['barros blancos', 'pueblo nuevo', 'bolivar', 'las canteras'],
  5: ['pocitos', 'buceo', 'malvin', 'punta carretas', 'parque rodo', 'palermo', 'cordon', 'tres cruces', 'villa espanola', 'union'],
  6: ['punta gorda', 'carrasco', 'shangrila', 'neptunia', 'el pinar'],
  7: ['ciudad vieja', 'centro', 'goes', 'la comercial', 'aguada', 'reducto', 'belvedere', 'la blanqueada', 'figurita', 'jacinto vera', 'sayago', 'nuevo paris', 'cerro', 'la teja', 'paso molino', 'penarol'],
  8: ['progreso', 'las piedras', 'sauce', 'empalme olmos', 'juanico'],
  9: ['pando', 'toledo este', 'lagomar', 'solymar', 'la floresta'],
  10: ['ciudad de la costa', 'atlantida', 'parque del plata', 'salinas', 'costa'],
  11: ['canelones ciudad', 'canelones capital', '14 de julio'],
};
const COSTOS_GESTIONPOST = { 1:169,2:169,3:169,4:169,5:169,6:169,7:139,8:200,9:200,10:200,11:200 };
const RETIRO_GESTIONPOST = 75;

function normalizarTexto(t) {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function detectarZona(dir) {
  if (!dir) return null;
  const d = normalizarTexto(dir);
  for (const [zona, kws] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of kws) { if (d.includes(normalizarTexto(kw))) return parseInt(zona); }
  }
  return null;
}

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
        const transportistaCorrecto = esFlex ? 'gestionpost' : 'mercado_envios';

        // Recalcular dirección y costo si hay cambio
        let direccion = envio.direccion;
        if (!direccion && shipData?.receiver_address) {
          const addr = shipData.receiver_address;
          direccion = `${addr.street_name} ${addr.street_number}, ${addr.city?.name}, ${addr.state?.name}`;
        }
        const zona = esFlex ? detectarZona(direccion) : null;
        const costoFlexCalculado = zona ? (COSTOS_GESTIONPOST[zona] || 200) + RETIRO_GESTIONPOST : (shipData?.base_cost || 0);
        const costoCorrecto = esFlex ? costoFlexCalculado : 0;

        const hayCambioTransportista = envio.transportista !== transportistaCorrecto;
        const hayCambioDir = !envio.direccion && direccion;

        if (!hayCambioTransportista && !hayCambioDir) {
          sinCambio++;
          continue;
        }

        log.push(`${dryRun ? '[DRY]' : '🔄'} ${envio.id}: ${envio.transportista} → ${transportistaCorrecto} | logistic="${logisticType}" | zona ${zona || 'N/D'} | costo $${costoCorrecto}`);

        if (!dryRun) {
          const update = { transportista: transportistaCorrecto, costo: costoCorrecto };
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
