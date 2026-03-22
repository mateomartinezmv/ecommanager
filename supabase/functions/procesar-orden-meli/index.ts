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
  for (const [zona, keywords] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of keywords) {
      if (dir.includes(normalizarTexto(kw))) return parseInt(zona)
    }
  }
  return null
}

function calcularCostoFlex(direccion: string): { zona: number, recomendada: string, costo: number, enviosuy: number | null, gestionpost: number } | null {
  const zona = detectarZona(direccion)
  if (!zona) return null

  const costoEnviosUy = COSTOS_ENVIOSUY[zona] ?? null
  const costoGestionPost = (COSTOS_GESTIONPOST[zona] ?? 200) + RETIRO_GESTIONPOST

  // EnviosUy por defecto, GestionPost si no cubre la zona
  const recomendada = 'gestionpost'  // Siempre GestionPost para Flex
  const costo = costoGestionPost

  return { zona, recomendada, costo, enviosuy: costoEnviosUy, gestionpost: costoGestionPost }
}


// =====================
// CALCULAR COMISIÓN MELI
// =====================
function calcularComision(precioUnit: number, cantidad: number, tipoEnvio: string, zonaFlex?: number | null): number {
  // Comisión = 15% del precio. El costo de envío se guarda separado en envios.costo
  return Math.round(precioUnit * cantidad * 0.15 * 100) / 100
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

  // Detectar tipo de envío
  const esML = order.shipping?.logistic_type === 'cross_docking'
  const esFlex = order.shipping?.logistic_type === 'self_service_flex'
  const tipoEnvio = esFlex ? 'flex' : esML ? 'mercado_envios' : 'otro'
  log.push(`📬 Tipo de envío: ${tipoEnvio}`)

  // Obtener dirección de envío para calcular costo Flex
  log.push('Obteniendo datos de envío...')
  const shipmentId = order.shipping?.id ? String(order.shipping.id) : null
  const { direccion, logisticType: shipLogisticType, costoReal } = await getDatosEnvio(orderId, shipmentId, token)
  log.push(`📍 Dirección: ${direccion || 'no disponible'}`)

  const esFlex = shipLogisticType === 'self_service_flex'
  log.push(`📬 Tipo de envío: ${esFlex ? 'flex' : 'mercado_envios'} (logistic_type: ${shipLogisticType || 'n/a'}) | Costo real: $${costoReal}`)

  let flexInfo = null
  if (esFlex && direccion) {
    flexInfo = calcularCostoFlex(direccion)
    if (flexInfo) {
      log.push(`🗺️ Zona detectada: ${flexInfo.zona} | Costo Flex: $${flexInfo.costo}`)
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
        comision: calcularComision(precioUnit, cantidad, esFlex ? 'flex' : 'mercado_envios', flexInfo?.zona),
        total: precioUnit * cantidad, estado: 'pagada',
        genera_envio: true, notas: 'Auto-registrada por webhook MELI',
      })
      if (ventaErr) throw new Error(`Error insertando venta: ${ventaErr.message}`)
      log.push(`✅ Venta registrada: ${ventaId}`)
      resultados.push({ item: meliItemId, estado: 'registrada', ventaId })
    }

    // Registrar envío con costo Flex automático
    const envioId = `E_MELI_${order.id}_${meliItemId}`
    const { data: envioExistente } = await supabase.from('envios').select('id').eq('id', envioId).single()

    if (!envioExistente) {
      const transportista = esFlex ? 'gestionpost' : 'mercado_envios'
      const costoEnvio = costoReal > 0 ? costoReal : (flexInfo?.costo || 0)

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
