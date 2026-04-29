// supabase/functions/procesar-orden-meli/index.ts
// Procesa órdenes MELI: registra venta, descuenta stock, crea envío con costo Flex automático

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
  11: null, // No realizan envíos
}

const COSTOS_GESTIONPOST: Record<number, number> = {
  1: 169, 2: 169, 3: 169, 4: 169, 5: 169, 6: 169,
  7: 139,
  8: 200, 9: 200, 10: 200, 11: 200,
}
const RETIRO_GESTIONPOST = 75

// Palabras clave por zona para detectar desde la dirección
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
  return texto.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
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

function calcularCostoFlex(direccion: string, fecha: string | Date): { zona: number, recomendada: string, costo: number, enviosuy: number | null, gestionpost: number } | null {
  const zona = detectarZona(direccion)
  if (!zona) return null

  const costoEnviosUy = COSTOS_ENVIOSUY[zona] ?? null
  const costoGestionPost = (COSTOS_GESTIONPOST[zona] ?? 200) + RETIRO_GESTIONPOST

  const recomendada = seleccionarTransportista(zona, fecha)
  const costo = recomendada === 'enviosuy' ? (costoEnviosUy ?? costoGestionPost) : costoGestionPost

  return { zona, recomendada, costo, enviosuy: costoEnviosUy, gestionpost: costoGestionPost }
}


// =====================
// CALCULAR COMISIÓN MELI
// =====================
function calcularComision(precioUnit: number, cantidad: number, costoEnvio: number = 0): number {
  // Comisión = 15% del precio + costo de envío que cobra MELI
  const base = Math.round(precioUnit * cantidad * 0.15 * 100) / 100
  return Math.round((base + costoEnvio) * 100) / 100
}

// =====================
// MAIN HANDLER
// =====================
Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const ordenId = body.orden_id
    if (!ordenId) return new Response(JSON.stringify({ error: 'Falta orden_id' }), { status: 400 })

    const log: string[] = []
    const resultado = await procesarOrden(String(ordenId), log)

    return new Response(JSON.stringify({ ok: true, log, resultado }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
})

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
// OBTENER ORDEN
// =====================
async function getOrder(orderId: string, token: string): Promise<any> {
  const r1 = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  const d1 = await r1.json()
  if (!d1.error) return d1

  const meRes = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  const me = await meRes.json()

  const r2 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&q=${orderId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  const d2 = await r2.json()
  if (d2.results?.length > 0) return d2.results[0]

  const r3 = await fetch(`https://api.mercadolibre.com/orders/search?seller=${me.id}&sort=date_desc&limit=20`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  const d3 = await r3.json()
  if (d3.results) {
    const found = d3.results.find((o: any) => String(o.id) === String(orderId))
    if (found) return found
  }

  throw new Error(`No se pudo obtener la orden ${orderId}`)
}

// =====================
// OBTENER DATOS DE ENVÍO (dirección + logistic_type + costo real)
// =====================
async function getDatosEnvio(orderId: string, shipmentId: string | null, token: string): Promise<{ direccion: string | null, logisticType: string, costoReal: number }> {
  let direccion: string | null = null
  let logisticType = ''
  let costoReal = 0
  try {
    const url = shipmentId
      ? `https://api.mercadolibre.com/shipments/${shipmentId}`
      : `https://api.mercadolibre.com/orders/${orderId}/shipments`
    const shipRes = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
    const shipData = await shipRes.json()
    logisticType = shipData?.logistic_type || shipData?.type || ''
    costoReal = shipData?.shipping_option?.list_cost || shipData?.base_cost || 0
    if (shipData?.receiver_address) {
      const addr = shipData.receiver_address
      direccion = [addr.street_name, addr.street_number, addr.neighborhood?.name, addr.city?.name, addr.state?.name].filter(Boolean).join(', ')
    }
    const FLEX_TYPES = ['self_service', 'self_service_flex']
    if (FLEX_TYPES.includes(logisticType)) {
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
  } catch (_) {}
  return { direccion, logisticType, costoReal }
}

// Mantener compatibilidad
async function getDireccionEnvio(orderId: string, token: string): Promise<string | null> {
  const datos = await getDatosEnvio(orderId, null, token)
  return datos.direccion
}

// =====================
// PROCESAR ORDEN
// =====================
async function procesarOrden(orderId: string, log: string[]): Promise<any> {
  log.push('Obteniendo token...')
  const token = await getMeliToken()
  log.push('✅ Token OK')

  log.push(`Buscando orden ${orderId}...`)
  const order = await getOrder(orderId, token)
  log.push(`✅ Orden encontrada. Estado: ${order.status}, items: ${order.order_items?.length}`)

  if (order.status !== 'paid') {
    log.push(`⚠️ Orden no pagada (${order.status}), ignorando`)
    return { ignorada: true, estado: order.status }
  }

  // Obtener datos de envío
  log.push('Obteniendo datos de envío...')
  const shipmentId = order.shipping?.id ? String(order.shipping.id) : null
  const { direccion, logisticType: shipLogisticType, costoReal } = await getDatosEnvio(orderId, shipmentId, token)
  log.push(`📍 Dirección: ${direccion || 'no disponible'}`)

  const FLEX_TYPES = ['self_service', 'self_service_flex']
  const esFlex = FLEX_TYPES.includes(shipLogisticType)
  log.push(`📬 Tipo de envío: ${esFlex ? 'flex' : 'mercado_envios'} (logistic_type: ${shipLogisticType || 'n/a'}) | Costo real: $${costoReal}`)

  let flexInfo = null
  if (esFlex && direccion) {
    flexInfo = calcularCostoFlex(direccion, order.date_created || new Date().toISOString())
    if (flexInfo) {
      log.push(`🗺️ Zona detectada: ${flexInfo.zona} | ${flexInfo.recomendada} | Costo Flex: $${flexInfo.costo}`)
    }
  }

  const resultados = []

  for (const item of order.order_items || []) {
    const meliItemId = item.item?.id
    const cantidad = item.quantity || 1
    const precioUnit = item.unit_price || 0
    if (!meliItemId) continue

    log.push(`Procesando item ${meliItemId} x${cantidad} $${precioUnit}`)

    const { data: producto } = await supabase
      .from('productos').select('*').eq('meli_id', meliItemId).single()

    let skuFinal: string, nombreFinal: string

    if (!producto) {
      log.push(`⚠️ Producto no encontrado, auto-creando...`)
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
          meli_id: meliItemId, notas: 'Auto-creado por webhook MELI',
        })
        log.push(`✅ Producto auto-creado: ${skuAuto}`)
      }
      skuFinal = skuAuto
      nombreFinal = nombreItem
    } else {
      const nuevoStockDep = Math.max(0, producto.stock_dep - cantidad)
      const nuevoStockMeli = Math.max(0, producto.stock_meli - cantidad)
      await supabase.from('productos').update({
        stock_dep: nuevoStockDep, stock_meli: nuevoStockMeli,
        updated_at: new Date().toISOString(),
      }).eq('sku', producto.sku)
      log.push(`✅ Stock: ${producto.sku} dep=${nuevoStockDep} meli=${nuevoStockMeli}`)
      skuFinal = producto.sku
      nombreFinal = producto.nombre
    }

    // Registrar venta
    const ventaId = `V_MELI_${order.id}_${meliItemId}`
    const { data: ventaExistente } = await supabase.from('ventas').select('id').eq('id', ventaId).single()

    // Calcular costo y transportista del envío (necesario también para la comisión de la venta)
    const transportista = esFlex ? (flexInfo?.recomendada || 'gestionpost') : 'mercado_envios'
    const costoEnvio = esFlex ? (flexInfo?.costo ?? costoReal ?? 0) : 0

    if (ventaExistente) {
      log.push(`ℹ️ Venta ${ventaId} ya existe`)
      resultados.push({ item: meliItemId, estado: 'ya_existe' })
    } else {
      const { error: ventaErr } = await supabase.from('ventas').insert({
        id: ventaId, canal: 'meli',
        fecha: order.date_created?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        orden_meli: String(order.id),
        comprador: order.buyer?.nickname || '',
        sku: skuFinal, producto: nombreFinal,
        cantidad, precio_unit: precioUnit,
        comision: calcularComision(precioUnit, cantidad, costoEnvio),
        total: precioUnit * cantidad, estado: 'pagada',
        genera_envio: !!shipmentId, notas: 'Auto-registrada por webhook MELI',
      })
      if (ventaErr) throw new Error(`Error insertando venta: ${ventaErr.message}`)
      log.push(`✅ Venta registrada: ${ventaId}`)
      resultados.push({ item: meliItemId, estado: 'registrada', ventaId })
    }

    // Registrar envío con costo Flex automático
    const envioId = `E_MELI_${order.id}_${meliItemId}`
    const { data: envioExistente } = await supabase.from('envios').select('id').eq('id', envioId).single()

    if (!envioExistente) {

      const { error: envioErr } = await supabase.from('envios').insert({
        id: envioId,
        venta_id: ventaId,
        orden: String(order.id),
        comprador: order.buyer?.nickname || '',
        producto: nombreFinal,
        transportista,
        tracking: null,
        fecha_despacho: null,
        estado: 'pendiente',
        direccion: direccion || null,
        costo: costoEnvio,
      })

      if (envioErr) {
        log.push(`⚠️ Error creando envío: ${envioErr.message}`)
      } else {
        log.push(`✅ Envío creado: zona ${flexInfo?.zona || '?'} | ${transportista} | $${costoEnvio}`)
      }
    } else {
      log.push(`ℹ️ Envío ${envioId} ya existe`)
    }
  }

  return resultados
}
