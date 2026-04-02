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
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

function calcularCostoFlex(direccion: string) {
  const zona = detectarZona(direccion)
  if (!zona) return null
  const costoEnviosUy = COSTOS_ENVIOSUY[zona] ?? null
  const costoGestionPost = (COSTOS_GESTIONPOST[zona] ?? 200) + RETIRO_GESTIONPOST
  const recomendada = 'gestionpost'  // Siempre GestionPost para Flex
  const costo = costoGestionPost
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
      costoEnvioReal = shipData?.shipping_option?.list_cost || shipData?.base_cost || 0
      if (shipData?.receiver_address) {
        const addr = shipData.receiver_address
        direccion = `${addr.street_name} ${addr.street_number}, ${addr.city?.name}, ${addr.state?.name}`
      }
    } catch (_) {
      // Fallback: mercado_envios, costo 0
    }
  }

  log.push(`🔍 shipment logistic_type: ${logisticType || 'n/a'} (shipping_id: ${shippingId || 'n/a'})`)

  const esFlex = logisticType === 'fulfillment' || logisticType === 'self_service'
  const transportisteFinal = esFlex ? 'gestionpost' : 'mercado_envios'
  // Para Flex: costo real del envío (lo pagás vos). Para ME: $0 (ya incluido en comisión)
  const costoEnvio = esFlex ? costoEnvioReal : 0

  // Comisión desde fee_details
  const feeDetails = order.fee_details || []
  const totalFee = feeDetails
    .filter((f: any) => f.type === 'mercadopago_fee' || f.type === 'ml_fee')
    .reduce((s: number, f: any) => s + Math.abs(f.amount || 0), 0)
  const hasFeeDetails = totalFee > 0
  const orderTotalCalc = (order.order_items || []).reduce((s: number, i: any) => s + (i.unit_price * i.quantity), 0) || 1

  log.push(`📬 Tipo envío: ${transportisteFinal} | comisión total: $${totalFee}`)

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

    // Comisión por item
    const comisionItem = hasFeeDetails
      ? Math.round((totalFee * (precioUnit * cantidad) / orderTotalCalc) * 100) / 100
      : Math.abs(item.sale_fee || 0)

    log.push(`💰 Comisión: $${comisionItem} | Envío: ${transportisteFinal}`)

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
