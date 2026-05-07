// supabase/functions/sync-meli-orders/index.ts
// Corre cada 2 horas via cron de Supabase
// Busca las últimas 50 órdenes pagadas de MELI y registra las que falten

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MELI_CLIENT_ID = Deno.env.get('MELI_CLIENT_ID')!
const MELI_CLIENT_SECRET = Deno.env.get('MELI_CLIENT_SECRET')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// =====================
// TABLA DE COSTOS FLEX
// =====================
const COSTOS_ENVIOSUY: Record<number, number | null> = {
  1: 190, 2: 190, 3: 190, 4: 190,
  5: 180, 7: 180,
  6: 160,
  8: 240, 9: 240,
  10: 200,
  11: null,
}
const COSTOS_GESTIONPOST: Record<number, number> = {
  1: 169, 2: 169, 3: 169, 4: 169, 5: 169, 6: 169,
  7: 139,
  8: 200, 9: 200, 10: 200, 11: 200,
}
const RETIRO_GESTIONPOST = 75

const ZONAS_KEYWORDS: Record<number, string[]> = {
  1: ['villa del cerro', 'punta espinillo', 'santiago vazquez', 'tres ombues', 'paso de la arena', 'pajas blancas', 'nuevo paris', 'la paloma', 'victoria', 'casabo', 'cerro'],
  2: ['cuchilla pereira', 'conciliacion', 'abayuba', 'melilla', 'lezica', 'colon'],
  3: ['toledo chico', 'villa garcia', 'manga'],
  4: ['banados de carrasco', 'bella italia', 'chacarita', 'punta rieles'],
  5: ['flor de maronas', 'carrasco norte', 'malvin norte', 'puerto buceo', 'pocitos nuevo', 'playa verde', 'las canteras', 'punta gorda', 'maronas', 'carrasco', 'buceo', 'malvin', 'union'],
  6: ['ciudad vieja', 'parque batlle', 'villa biarritz', 'villa dolores', 'la blanqueada', 'punta carretas', 'la comercial', 'parque rodo', 'barrio sur', 'villa munoz', 'tres cruces', 'jacinto vera', 'larranaga', 'figurita', 'reducto', 'palermo', 'aguada', 'pocitos', 'cordon', 'centro', 'goes'],
  7: ['cementerio del norte', 'paso de las duranas', 'jardines hipodromo', 'piedras blancas', 'villa espanola', 'brazo oriental', 'bella vista', 'arroyo seco', 'aires puros', 'castro perez', 'castellanos', 'paso molino', 'las acacias', 'ituzaingo', 'atahualpa', 'casavalle', 'belvedere', 'lavalleja', 'capurro', 'cerrito', 'marconi', 'bolivar', 'la teja', 'sayago', 'penarol', 'prado'],
  8: ['las piedras', 'progreso', 'la paz'],
  9: ['cumbres de carrasco', 'rincon de carrasco', 'joaquin suarez', 'barros blancos', 'casarino', 'toledo', 'suarez', 'pando'],
  10: ['ciudad de la costa', 'colinas de carrasco', 'colinas de solymar', 'medanos de solymar', 'montes de solymar', 'san jose de carrasco', 'lomas de carrasco', 'barra de carrasco', 'parque de solymar', 'lomas de solymar', 'paso de carrasco', 'pinares de solymar', 'villa aeroparque', 'empalme nicolich', 'parque miramar', 'parque carrasco', 'la tahona', 'el dorado', 'el bosque', 'el pinar', 'shangrila', 'lagomar', 'solymar'],
  11: ['canelones ciudad', 'canelones capital'],
}

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function detectarZona(direccion: string): number | null {
  if (!direccion) return null
  const dir = normalizarTexto(direccion)

  // Ordenar de mayor a menor longitud: keywords mas especificos ganan sobre los mas cortos
  const allKeywords: Array<[string, number]> = []
  for (const [zona, keywords] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of keywords) {
      allKeywords.push([normalizarTexto(kw), parseInt(zona)])
    }
  }
  allKeywords.sort((a, b) => b[0].length - a[0].length)

  for (const [kw, zona] of allKeywords) {
    if (dir.includes(kw)) return zona
  }
  return null
}

// =====================
// SELECCIÓN POR HORARIO (MONTEVIDEO)
// =====================
function getTimeMVD(fecha: string | Date): { hora: number; minuto: number; weekday: string } {
  const date = fecha instanceof Date ? fecha : new Date(fecha)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Montevideo',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  return {
    hora: parseInt(map.hour),
    minuto: parseInt(map.minute || '0'),
    weekday: map.weekday,
  }
}

function seleccionarTransportista(zona: number, fecha: string | Date): 'enviosuy' | 'gestionpost' {
  if (zona === 11) return 'gestionpost'
  const { hora, minuto, weekday } = getTimeMVD(fecha)
  const hm = hora * 60 + minuto
  if (weekday === 'Sun') return 'enviosuy'
  if (weekday === 'Sat') {
    if (hm < 12 * 60) return 'enviosuy'
    if (hm < 13 * 60) return 'gestionpost'
    return 'enviosuy'
  }
  // Lun-Vie
  if (hm < 15 * 60) return 'enviosuy'
  if (hm < 16 * 60) return 'gestionpost'
  return 'enviosuy'
}

function calcularCostoFlex(direccion: string, fecha: string | Date) {
  const zona = detectarZona(direccion)
  if (!zona) return null
  const costoEnviosUy = COSTOS_ENVIOSUY[zona] ?? null
  const costoGestionPost = (COSTOS_GESTIONPOST[zona] ?? 200) + RETIRO_GESTIONPOST
  const recomendada = seleccionarTransportista(zona, fecha)
  const costo = recomendada === 'enviosuy' ? (costoEnviosUy ?? costoGestionPost) : costoGestionPost
  return { zona, recomendada, costo }
}


// =====================
// CALCULAR COMISIÓN MELI
// =====================
function calcularComision(precioUnit: number, cantidad: number, costoEnvio: number): number {
  // Comisión = 15% del precio + costo de envío que cobra MELI
  const base = Math.round(precioUnit * cantidad * 0.15 * 100) / 100
  return Math.round((base + costoEnvio) * 100) / 100
}

// =====================
// TOKEN MELI
// =====================
async function getMeliToken(): Promise<string> {
  const { data, error } = await supabase.from('meli_tokens').select('*').eq('id', 1).single()
  if (error || !data) throw new Error('MELI no conectado')

  const now = new Date()
  const expiresAt = new Date(data.expires_at)

  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    const refreshRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: MELI_CLIENT_ID,
        client_secret: MELI_CLIENT_SECRET,
        refresh_token: data.refresh_token,
      }),
    })
    const newToken = await refreshRes.json()
    if (newToken.error) throw new Error('No se pudo refrescar token: ' + newToken.message)
    const newExpiry = new Date(Date.now() + newToken.expires_in * 1000).toISOString()
    await supabase.from('meli_tokens').update({
      access_token: newToken.access_token,
      refresh_token: newToken.refresh_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    }).eq('id', 1)
    return newToken.access_token
  }
  return data.access_token
}

// =====================
// PROCESAR UNA ORDEN
// =====================
async function procesarOrden(order: any, token: string, log: string[]) {
  if (order.status !== 'paid') {
    log.push(`⏭️ Orden ${order.id} ignorada (estado: ${order.status})`)
    return
  }

  // Leer shipment para determinar tipo de envío
  const shippingId = order.shipping?.id
  let logisticType = ''
  let direccion: string | null = null
  let costoEnvioReal = 0

  if (shippingId) {
    try {
      const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const shipData = await shipRes.json()
      logisticType = shipData?.logistic_type || ''
      // cost = cargo al vendedor; list_cost = precio al comprador (no usamos list_cost)
      costoEnvioReal = shipData?.shipping_option?.cost ?? shipData?.shipping_option?.list_cost ?? shipData?.base_cost ?? 0
      if (shipData?.receiver_address) {
        const addr = shipData.receiver_address
        direccion = `${addr.street_name} ${addr.street_number}, ${addr.city?.name}, ${addr.state?.name}`
      }
      const FLEX_TYPES_LOG = ['self_service', 'self_service_flex']
      if (FLEX_TYPES_LOG.includes(logisticType)) {
        console.log('FLEX_SHIPDATA_DEBUG:', JSON.stringify({
          id: shipData?.id,
          logistic_type: shipData?.logistic_type,
          service_id: shipData?.service_id,
          substatus: shipData?.substatus,
          tags: shipData?.tags,
          shipping_option: shipData?.shipping_option,
          neighborhood: shipData?.receiver_address?.neighborhood,
          receiver_types: shipData?.receiver_address?.types,
          route: shipData?.route,
        }))
      }
    } catch (_) {
      // Fallback: mercado_envios, costo 0
    }
  }

  log.push(`🔍 shipment logistic_type: ${logisticType || 'n/a'} (shipping_id: ${shippingId || 'n/a'})`)

  const FLEX_TYPES = ['self_service', 'self_service_flex']
  const esFlex = FLEX_TYPES.includes(logisticType)
  const flexFecha = order.date_created || new Date().toISOString()
  const flexInfo = esFlex && direccion ? calcularCostoFlex(direccion, flexFecha) : null
  const transportisteFinal = esFlex ? (flexInfo?.recomendada || 'gestionpost') : 'mercado_envios'
  const costoEnvio = esFlex ? (flexInfo?.costo ?? costoEnvioReal ?? 0) : 0

  // ── Cálculo de deducciones MELI ─────────────────────────────────────────────
  // Método primario: net_received_amount = lo que MELI acredita al vendedor tras
  // descontar comisión + envío + cualquier cargo. Es la fuente más exacta.
  const approvedPayment = (order.payments || []).find((p: any) => p.status === 'approved')
  const netReceived = approvedPayment?.net_received_amount || 0
  const grossTotal = (order.order_items || []).reduce((s: number, i: any) => s + (i.unit_price * i.quantity), 0) || 1
  const totalDeductionOrder = (netReceived > 0 && netReceived < grossTotal)
    ? Math.round((grossTotal - netReceived) * 100) / 100
    : null

  log.push(`📬 Tipo envío: ${transportisteFinal} | gross=$${grossTotal} net=$${netReceived} deducción=${totalDeductionOrder}`)

  for (const item of order.order_items || []) {
    const meliItemId = item.item?.id
    const cantidad = item.quantity || 1
    const precioUnit = item.unit_price || 0
    if (!meliItemId) continue

    // Verificar si la venta ya existe
    const ventaId = `V_MELI_${order.id}_${meliItemId}`
    const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single()
    if (ventaExistente) {
      log.push(`ℹ️ Venta ${ventaId} ya existe`)
      continue
    }

    // Buscar producto
    const { data: producto } = await supabase.from('productos').select('*').eq('meli_id', meliItemId).single()

    let skuFinal: string, nombreFinal: string

    if (!producto) {
      // Auto-crear producto si no existe
      const skuAuto = `MELI-${meliItemId}`
      let nombreItem = item.item?.title || `Producto MELI ${meliItemId}`
      try {
        const ir = await fetch(`https://api.mercadolibre.com/items/${meliItemId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        const id = await ir.json()
        if (!id.error) nombreItem = id.title
      } catch (_) {}

      const { data: existe } = await supabase.from('productos').select('sku').eq('sku', skuAuto).single()
      if (!existe) {
        await supabase.from('productos').insert({
          sku: skuAuto, nombre: nombreItem,
          stock_dep: 0, stock_meli: 0, costo: 0,
          precio: precioUnit, alerta_min: 3,
          meli_id: meliItemId, notas: 'Auto-creado por sync MELI',
        })
      }
      skuFinal = skuAuto
      nombreFinal = nombreItem
    } else {
      // Descontar stock
      const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad)
      const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad)
      await supabase.from('productos').update({
        stock_dep: nuevoStockDep, stock_meli: nuevoStockMeli,
        updated_at: new Date().toISOString(),
      }).eq('sku', producto.sku)
      skuFinal = producto.sku
      nombreFinal = producto.nombre
    }

    let comisionItem: number
    if (totalDeductionOrder !== null) {
      // Método primario: proporcional al gross (cubre comisión + envío exactamente)
      comisionItem = Math.round((totalDeductionOrder * (precioUnit * cantidad) / grossTotal) * 100) / 100
    } else {
      // Fallback: sale_fee + estimación de envío
      const saleFee = Math.abs(item.sale_fee || 0)
      const feeDetails = order.fee_details || []
      const totalFeeDetails = feeDetails.reduce((s: number, f: any) => s + Math.abs(f.amount || 0), 0)
      const feeProportional = totalFeeDetails > 0
        ? Math.round((totalFeeDetails * (precioUnit * cantidad) / grossTotal) * 100) / 100
        : 0
      const mlFee = saleFee > 0 ? saleFee : feeProportional
      const shippingShare = !esFlex
        ? Math.round((costoEnvioReal * (precioUnit * cantidad) / grossTotal) * 100) / 100
        : 0
      comisionItem = Math.round((mlFee + shippingShare) * 100) / 100
    }

    log.push(`💰 Comisión final: $${comisionItem} (método: ${totalDeductionOrder !== null ? 'net_received' : 'fallback'})`)

    // Registrar venta
    await supabase.from('ventas').insert({
      id: ventaId, canal: 'meli',
      fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      orden_meli: String(order.id),
      comprador: order.buyer?.nickname || '',
      sku: skuFinal, producto: nombreFinal,
      cantidad, precio_unit: precioUnit, comision: comisionItem,
      total: precioUnit * cantidad, estado: 'pagada',
      genera_envio: !!shippingId, notas: 'Auto-registrada por sync MELI',
    })
    log.push(`✅ Venta registrada: ${ventaId} — ${nombreFinal}`)

    if (shippingId) {
      const envioId = `E_MELI_${order.id}_${meliItemId}`
      const { data: envioExistente } = await supabase.from('envios').select('id').eq('id', envioId).single()

      if (!envioExistente) {
        await supabase.from('envios').insert({
          id: envioId, venta_id: ventaId,
          orden: String(order.id),
          comprador: order.buyer?.nickname || '',
          producto: nombreFinal,
          transportista: transportisteFinal,
          tracking: null, fecha_despacho: null, estado: 'pendiente',
          direccion: direccion || null,
          costo: costoEnvio,
        })
        log.push(`✅ Envío creado: ${transportisteFinal} $${costoEnvio}`)
      }
    }
  }
}

// =====================
// MAIN
// =====================
Deno.serve(async (req) => {
  const log: string[] = []

  try {
    log.push('🔄 Iniciando sync de órdenes MELI...')
    const token = await getMeliToken()
    log.push('✅ Token OK')

    // Obtener usuario MELI
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    const me = await meRes.json()
    log.push(`👤 Usuario: ${me.nickname} (${me.id})`)

    // Buscar órdenes de los últimos 14 días con paginación para no perder órdenes
    // (aumentado de 7 a 14 días y de 50 a 200 por página para mayor cobertura)
    const DAYS_BACK = 14
    const PAGE_SIZE = 200
    const desde = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString()

    // Función auxiliar para paginar resultados de MELI
    async function fetchAllOrders(baseUrl: string): Promise<any[]> {
      const results: any[] = []
      let offset = 0
      while (true) {
        const url = `${baseUrl}&limit=${PAGE_SIZE}&offset=${offset}`
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
        const data = await res.json()
        const batch = data.results || []
        results.push(...batch)
        // Si devolvió menos que PAGE_SIZE, no hay más páginas
        if (batch.length < PAGE_SIZE) break
        offset += PAGE_SIZE
        // Tope de seguridad: máximo 1000 órdenes por búsqueda
        if (offset >= 1000) break
      }
      return results
    }

    // Búsqueda 1: órdenes pagadas (paginada)
    const paidResults = await fetchAllOrders(
      `https://api.mercadolibre.com/orders/search?seller=${me.id}&order.status=paid&sort=date_desc&order.date_created.from=${desde}`
    )

    // Búsqueda 2: órdenes recientes sin filtro de status (captura series de IDs alternativas)
    const recentResults = await fetchAllOrders(
      `https://api.mercadolibre.com/orders/search?seller=${me.id}&sort=date_desc&order.date_created.from=${desde}`
    )

    // Combinar y deduplicar por ID
    const todasOrdenes = [...paidResults, ...recentResults]
    const idsVistos = new Set()
    const ordenes = todasOrdenes.filter(o => {
      if (idsVistos.has(o.id)) return false
      idsVistos.add(o.id)
      return true
    })
    log.push(`📦 Órdenes últimos ${DAYS_BACK} días: ${ordenes.length} (${paidResults.length} pagadas + ${recentResults.length} recientes deduplicadas)`)

    for (const order of ordenes) {
      // Obtener detalle completo de la orden para tener logistic_type
      let orderDetalle = order
      try {
        const detRes = await fetch(`https://api.mercadolibre.com/orders/${order.id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        const detData = await detRes.json()
        if (!detData.error) orderDetalle = detData
      } catch(_) {}
      await procesarOrden(orderDetalle, token, log)
    }

    log.push('✅ Sync completado')
    return new Response(JSON.stringify({ ok: true, log }), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (err: any) {
    log.push(`❌ Error: ${err.message}`)
    return new Response(JSON.stringify({ ok: false, error: err.message, log }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
})
