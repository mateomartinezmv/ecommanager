// api/_stockRespuesta.js
// Qué se le puede decir a un comprador de MELI sobre la disponibilidad de una publicación.
//
// La disponibilidad sale del CRM: stock_dep manda (no el stock de MELI ni el de Shopify), en
// packs completos si el producto se vende de a par, y si no hay se mira si viene en una
// importación que llega pronto.
//
// Además de la publicación preguntada, se miran sus variantes: los productos que se llaman
// igual salvo la última palabra (el color), como "Guardamanos … ABS - Rojo / - Azul / - Negro".
// Sin eso, a "¿tenés en negro?" en la publicación del rojo la IA sólo podía decir "consultá
// por esa variante", porque no sabía que el negro existe ni que está agotado.

const { buscarProductoPorMeliId } = require('./_meliIds');
const { packsDisponibles } = require('./_packs');

// Una importación cuenta como "vuelve pronto" si llega dentro de estos días (o si ya debía
// haber llegado y todavía no se marcó recibida: está al caer).
const DIAS_VUELVE_PRONTO = 30;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

const COLUMNAS = 'sku, nombre, grupo, stock_dep, unidades_por_venta, discontinuado';

const normalizar = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// "Guardamanos Protector Puños Moto Enduro Cross ABS - Rojo" → base "guardamanos … abs", variante "Rojo".
// "Puños Domino Para Moto Manubrio Goma Antideslizante Azul" → base "puños domino … antideslizante", variante "Azul".
function partirNombre(nombre) {
  const limpio = String(nombre || '').trim().replace(/\s+/g, ' ');
  const i = limpio.lastIndexOf(' ');
  if (i < 0) return { base: normalizar(limpio), variante: limpio };
  return {
    base: normalizar(limpio.slice(0, i).replace(/\s*[-–]\s*$/, '')),
    variante: limpio.slice(i + 1),
  };
}

// Las fechas de llegada de cada SKU que viene en una importación cercana.
async function llegadasCercanas(supabase, hoy = new Date(), dias = DIAS_VUELVE_PRONTO) {
  const { data, error } = await supabase
    .from('importaciones')
    .select('llegada, estado, items')
    .neq('estado', 'recibido');
  if (error || !data) return {};

  const limite = new Date(hoy.getTime() + dias * 86400000).toISOString().slice(0, 10);
  const porSku = {};
  for (const i of data) {
    if (i.estado === 'cancelada' || !i.llegada || i.llegada > limite) continue;
    for (const it of Array.isArray(i.items) ? i.items : []) {
      if (!it?.sku) continue;
      if (!porSku[it.sku] || i.llegada < porSku[it.sku]) porSku[it.sku] = i.llegada;
    }
  }
  return porSku;
}

function estadoDe(producto, llegadas) {
  if (producto.discontinuado) return { estado: 'descatalogado', disponibles: 0 };
  const disponibles = packsDisponibles(producto.stock_dep, producto);
  if (disponibles > 0) return { estado: 'con_stock', disponibles };
  if (llegadas[producto.sku]) return { estado: 'vuelve_pronto', disponibles: 0, llegada: llegadas[producto.sku] };
  return { estado: 'sin_stock', disponibles: 0 };
}

// Devuelve { estado, sku, nombre, disponibles, llegada, variantes } con estado:
//   con_stock | sin_stock | vuelve_pronto | descatalogado | sin_vincular
// `variantes` está sólo si el producto tiene otras variantes en el CRM, e incluye la propia
// (actual: true), cada una con su estado.
async function stockParaRespuesta(supabase, itemId, hoy = new Date()) {
  const producto = await buscarProductoPorMeliId(supabase, itemId, COLUMNAS);
  if (!producto) return { estado: 'sin_vincular' };

  const llegadas = await llegadasCercanas(supabase, hoy);
  const salida = { sku: producto.sku, nombre: producto.nombre, ...estadoDe(producto, llegadas) };

  const { data: todos } = await supabase.from('productos').select(COLUMNAS);
  const { base } = partirNombre(producto.nombre);
  const hermanos = (todos || []).filter(p =>
    partirNombre(p.nombre).base === base &&
    (!producto.grupo || !p.grupo || p.grupo === producto.grupo));
  if (hermanos.length > 1) {
    salida.variantes = hermanos
      .map(p => ({
        sku: p.sku,
        variante: partirNombre(p.nombre).variante,
        actual: p.sku === producto.sku,
        ...estadoDe(p, llegadas),
      }))
      .sort((a, b) => (b.actual - a.actual) || a.variante.localeCompare(b.variante));
  }
  return salida;
}

// ── Para el dueño (Telegram): qué supo el bot al redactar ──────────────────────────────
function textoVariante(v) {
  switch (v.estado) {
    case 'con_stock': return `${v.variante} ${v.disponibles}`;
    case 'vuelve_pronto': return `${v.variante} sin stock (llega ~${v.llegada})`;
    case 'descatalogado': return `${v.variante} descatalogado`;
    default: return `${v.variante} sin stock`;
  }
}

function lineaStock(stock) {
  if (!stock) return null;
  let linea;
  switch (stock.estado) {
    case 'con_stock': linea = `📊 <b>Stock CRM:</b> ${stock.disponibles} disponible${stock.disponibles === 1 ? '' : 's'}`; break;
    case 'vuelve_pronto': linea = `📊 <b>Stock CRM:</b> sin stock · viene en una importación (llegada estimada ${stock.llegada})`; break;
    case 'sin_stock': linea = `📊 <b>Stock CRM:</b> sin stock y sin importación en los próximos ${DIAS_VUELVE_PRONTO} días`; break;
    case 'descatalogado': linea = `📊 <b>Stock CRM:</b> descatalogado`; break;
    case 'sin_vincular': return `📊 <b>Stock CRM:</b> ⚠️ esta publicación no está vinculada a ningún producto`;
    default: return null;
  }
  const otras = (stock.variantes || []).filter(v => !v.actual);
  if (otras.length) linea += `\n🎨 <b>Otras variantes:</b> ${otras.map(textoVariante).join(' · ')}`;
  return linea;
}

// ── Para la IA ─────────────────────────────────────────────────────────────────────────
// Nunca cantidades ni fechas exactas: la llegada de una importación es estimada.
function paraIA(v) {
  switch (v.estado) {
    case 'con_stock': return 'hay stock';
    case 'vuelve_pronto': return 'sin stock, pero llega pronto';
    case 'descatalogado': return 'ya no la traemos';
    default: return 'sin stock por ahora, sin fecha de reposición';
  }
}

function reglaStock(stock) {
  const otraCosa = 'Aunque pregunten otra cosa (medidas, compatibilidad), aclarale en una frase corta que por ahora no hay stock.';
  let regla;
  switch (stock?.estado) {
    case 'con_stock':
      regla = 'Hay stock. No digas cuántas unidades quedan.';
      break;
    case 'vuelve_pronto': {
      const mes = MESES[Number(String(stock.llegada).slice(5, 7)) - 1];
      regla = `Ahora NO hay stock, pero está por llegar mercadería${mes ? ` (estimada para ${mes})` : ''}. ` +
        `Si preguntan por disponibilidad, decí que vuelve pronto, sin dar una fecha exacta. ${otraCosa}`;
      break;
    }
    case 'sin_stock':
      regla = `Ahora NO hay stock y no hay fecha de reposición. Nunca digas que hay stock ni prometas fechas. ${otraCosa}`;
      break;
    case 'descatalogado':
      regla = `Este producto ya no se vende y no se va a reponer. Nunca digas que hay stock. ${otraCosa}`;
      break;
    default:
      return 'No sabés si hay stock: no lo confirmes ni lo niegues. Si preguntan por disponibilidad, ' +
        'decí que se lo confirmás a la brevedad.';
  }

  if (stock.variantes?.length) {
    const lista = stock.variantes
      .map(v => `${v.variante}${v.actual ? ' (la de esta publicación)' : ''}: ${paraIA(v)}`)
      .join('; ');
    regla += ` Variantes de este mismo producto que vendemos: ${lista}. ` +
      'Si preguntan por otro color o variante, contestá con esta lista: cuáles hay, cuáles no tienen stock ' +
      '(y si llegan pronto) y, si la que piden no está en la lista, que esa no la traemos.';
  } else {
    regla += ' Si preguntan por otro color o variante, decí que de este producto solo tenemos la de la publicación.';
  }
  return regla;
}

module.exports = { stockParaRespuesta, lineaStock, reglaStock, partirNombre, llegadasCercanas, DIAS_VUELVE_PRONTO };
