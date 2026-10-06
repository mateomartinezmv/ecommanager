// api/meli/backfill-envios.js
// GET /api/meli/backfill-envios?limit=40&dry=1
//   → Crea los envíos faltantes de ventas MELI que quedaron sin registrar
//     (bug de notify.js que no creaba envíos entre 2026-05-28 y su fix).
//     Detecta Flex/EnviosUy con la misma lógica que notify.js.
//
// Parámetros opcionales:
//   ?limit=N  → máximo de ventas a procesar en esta corrida (default: 40, evita timeout)
//   ?dry=1    → modo dry-run: muestra qué crearía sin modificar nada

'use strict';

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { detectarZona, detectarZonaDesdeShipData, COSTOS_ENVIOSUY } = require('../_flexZonas');
const { packIdDeOrden, ordenesDelPaquete, registrarEnvioDePaquete } = require('../_meliPaquetes');

const FLEX_TYPES = ['self_service', 'self_service_flex'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const limit = parseInt(req.query.limit) || 40;
  const dryRun = req.query.dry === '1';
  const supabase = getSupabase();
  const log = [];

  try {
    const token = await getMeliToken();
    log.push(`✅ Token OK | dry=${dryRun} | limit=${limit}`);

    // Ventas MELI que deberían tener envío pero no lo tienen
    const { data: ventas, error: ventasErr } = await supabase
      .from('ventas')
      .select('id, orden_meli, comprador, producto, created_at')
      .eq('canal', 'meli')
      .eq('genera_envio', true)
      .order('created_at', { ascending: true });
    if (ventasErr) throw new Error('Error leyendo ventas: ' + ventasErr.message);

    const { data: enviosExistentes, error: enviosErr } = await supabase
      .from('envios').select('venta_id');
    if (enviosErr) throw new Error('Error leyendo envíos: ' + enviosErr.message);
    const idsConEnvio = new Set((enviosExistentes || []).map(e => e.venta_id));

    const faltantes = (ventas || []).filter(v => !idsConEnvio.has(v.id)).slice(0, limit);
    log.push(`📦 Ventas MELI sin envío: ${(ventas || []).filter(v => !idsConEnvio.has(v.id)).length} totales | procesando: ${faltantes.length}`);

    let creados = 0, sinShipping = 0, errores = 0;
    const resultados = [];
    // Las líneas de un carrito comparten paquete: alcanza con resolverlo una vez.
    const paquetesHechos = new Set();

    for (const venta of faltantes) {
      const ordenId = venta.orden_meli;
      if (!ordenId) { errores++; continue; }

      try {
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
          log.push(`ℹ Orden ${ordenId}: sin shipping_id (retiro) — omitiendo`);
          sinShipping++;
          continue;
        }

        const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const shipData = await shipRes.json();
        const logisticType = shipData?.logistic_type || '';
        const esFlex = FLEX_TYPES.includes(logisticType);

        let direccion = null;
        if (shipData?.receiver_address) {
          const addr = shipData.receiver_address;
          direccion = [addr.street_name, addr.street_number, addr.neighborhood?.name, addr.city?.name, addr.state?.name]
            .filter(Boolean).join(', ');
        }

        let zona = null;
        if (esFlex) {
          zona = detectarZonaDesdeShipData(shipData) || (direccion ? detectarZona(direccion) : null);
        }
        const transportista = esFlex ? 'enviosuy' : 'mercado_envios';
        const costo = esFlex ? (zona ? (COSTOS_ENVIOSUY[zona] ?? 0) : 0) : 0;

        // Un paquete, un envío: si esta venta viaja en un carrito ya resuelto
        // (o que ya tenía envío) no se crea otro, sólo se completa el detalle.
        const packId = packIdDeOrden(order);
        const paquete = packId || String(ordenId);
        if (paquetesHechos.has(paquete)) {
          log.push(`ℹ ${venta.id}: viaja en el paquete ${paquete}, ya resuelto en esta corrida`);
          continue;
        }
        paquetesHechos.add(paquete);

        log.push(`${dryRun ? '[DRY]' : '🔄'} ${venta.id}: envío del paquete ${paquete} | ${transportista} | zona ${zona ?? 'N/D'} | $${costo}`);

        if (!dryRun) {
          const ordenes = await ordenesDelPaquete(token, order, shippingId);
          const r = await registrarEnvioDePaquete(supabase, {
            order, packId, ordenes,
            datos: {
              comprador: venta.comprador || order.buyer?.nickname || '',
              transportista,
              direccion: direccion || null,
              costo,
              zona,
            },
          });
          if (!r.creado) {
            log.push(`ℹ Paquete ${paquete}: ya tenía envío${r.id ? ` (${r.id})` : ''} — no se duplica`);
            continue;
          }
        }

        resultados.push({ ventaId: venta.id, paquete, orden: ordenId, transportista, zona, costo });
        creados++;
      } catch (err) {
        log.push(`❌ Error procesando venta ${venta.id} (orden ${ordenId}): ${err.message}`);
        errores++;
      }
    }

    log.push(`\n✅ Resumen: ${creados} ${dryRun ? 'a crear' : 'creados'} | ${sinShipping} sin shipping (retiro) | ${errores} errores`);
    if (dryRun) log.push('⚠ Modo DRY RUN — no se realizaron cambios en la DB');

    return res.json({ ok: true, dryRun, creados, sinShipping, errores, log, resultados });
  } catch (err) {
    return res.json({ ok: false, log, error: err.message });
  }
};
