// api/_stockRespuesta.js
// Qué se le puede decir a un comprador de MELI sobre la disponibilidad de una publicación.
//
// Antes la IA que redacta las respuestas tenía la regla fija "hay stock", y contestaba eso
// también de productos agotados. Ahora la disponibilidad sale del CRM: stock_dep manda (no
// el stock de MELI ni el de Shopify), en packs completos si el producto se vende de a par, y
// si no hay se mira si viene en una importación que llega pronto.

const { buscarProductoPorMeliId } = require('./_meliIds');
const { packsDisponibles } = require('./_packs');

// Una importación cuenta como "vuelve pronto" si llega dentro de estos días (o si ya debía
// haber llegado y todavía no se marcó recibida: está al caer).
const DIAS_VUELVE_PRONTO = 30;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Devuelve { estado, sku, nombre, disponibles, llegada } con estado:
//   con_stock | sin_stock | vuelve_pronto | descatalogado | sin_vincular
async function stockParaRespuesta(supabase, itemId, hoy = new Date()) {
  const producto = await buscarProductoPorMeliId(
    supabase, itemId, 'sku, nombre, stock_dep, unidades_por_venta, discontinuado'
  );
  if (!producto) return { estado: 'sin_vincular' };

  const base = { sku: producto.sku, nombre: producto.nombre };
  if (producto.discontinuado) return { ...base, estado: 'descatalogado', disponibles: 0 };

  const disponibles = packsDisponibles(producto.stock_dep, producto);
  if (disponibles > 0) return { ...base, estado: 'con_stock', disponibles };

  const llegada = await proximaLlegada(supabase, producto.sku, hoy);
  if (llegada) return { ...base, estado: 'vuelve_pronto', disponibles: 0, llegada };
  return { ...base, estado: 'sin_stock', disponibles: 0 };
}

async function proximaLlegada(supabase, sku, hoy) {
  const { data, error } = await supabase
    .from('importaciones')
    .select('llegada, estado, items')
    .neq('estado', 'recibido');
  if (error || !data) return null;

  const limite = new Date(hoy.getTime() + DIAS_VUELVE_PRONTO * 86400000).toISOString().slice(0, 10);
  const fechas = data
    .filter(i => i.estado !== 'cancelada' && i.llegada && i.llegada <= limite)
    .filter(i => (Array.isArray(i.items) ? i.items : []).some(it => it?.sku === sku))
    .map(i => i.llegada)
    .sort();
  return fechas[0] || null;
}

// Una línea para el dueño (en Telegram): qué supo el bot al redactar.
function lineaStock(stock) {
  if (!stock) return null;
  switch (stock.estado) {
    case 'con_stock': return `📊 <b>Stock CRM:</b> ${stock.disponibles} disponible${stock.disponibles === 1 ? '' : 's'}`;
    case 'vuelve_pronto': return `📊 <b>Stock CRM:</b> sin stock · viene en una importación (llegada estimada ${stock.llegada})`;
    case 'sin_stock': return `📊 <b>Stock CRM:</b> sin stock y sin importación en los próximos ${DIAS_VUELVE_PRONTO} días`;
    case 'descatalogado': return `📊 <b>Stock CRM:</b> descatalogado`;
    case 'sin_vincular': return `📊 <b>Stock CRM:</b> ⚠️ esta publicación no está vinculada a ningún producto`;
    default: return null;
  }
}

// La regla que va en el prompt de la IA. Nunca cantidades ni fechas exactas: la llegada de
// una importación es estimada.
function reglaStock(stock) {
  const otraCosa = 'Aunque pregunten otra cosa (medidas, compatibilidad), aclarale en una frase corta que por ahora no hay stock.';
  switch (stock?.estado) {
    case 'con_stock':
      return 'Hay stock y se envía a todo Uruguay. No digas cuántas unidades quedan.';
    case 'vuelve_pronto': {
      const mes = MESES[Number(String(stock.llegada).slice(5, 7)) - 1];
      return `Ahora NO hay stock, pero está por llegar mercadería${mes ? ` (estimada para ${mes})` : ''}. ` +
        `Si preguntan por disponibilidad, decí que vuelve pronto, sin dar una fecha exacta. ${otraCosa}`;
    }
    case 'sin_stock':
      return `Ahora NO hay stock y no hay fecha de reposición. Nunca digas que hay stock ni prometas fechas. ${otraCosa}`;
    case 'descatalogado':
      return `Este producto ya no se vende y no se va a reponer. Nunca digas que hay stock. ${otraCosa}`;
    default:
      return 'No sabés si hay stock: no lo confirmes ni lo niegues. Si preguntan por disponibilidad, ' +
        'decí que se lo confirmás a la brevedad. Se envía a todo Uruguay.';
  }
}

module.exports = { stockParaRespuesta, lineaStock, reglaStock, DIAS_VUELVE_PRONTO };
