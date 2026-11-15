// api/_auditoriaPubs.js
// Lo que junta el cron de la auditoría quincenal de publicaciones de MELI
// (api/cron/pubs-auditoria.js) para que la tarea programada de Claude proponga títulos,
// fotos, ángulos y textos para la descripción.
//
// Partes (una invocación del cron cada una, en este orden):
//   · conversion     → la de la pestaña (endpoint api/meli/conversion), 30 días por producto.
//   · angulos        → cuántas publicaciones activas tiene cada producto y con qué títulos.
//   · fotos          → los ángulos que muestran otras fotos que la original.
//   · publicaciones  → el detalle de las candidatas a mejorar (ver elegirCandidatas): cada
//                      publicación con su título, precio, fotos, atributos, envío y visitas, y
//                      la descripción de la principal. Lee la conversión guardada ese día.
//   · preguntas      → lo que preguntaron los compradores en 60 días, por producto.

const { invocar } = require('./_invocar');
const { hoyEnUruguay, sumarDias, aligerar, resultado, correrYGuardar } = require('./_revisiones');
const { meliIdsDe } = require('./_meliIds');
const { packsDisponibles } = require('./_packs');

const TABLA = 'pubs_auditoria_partes';
const DIAS_CONVERSION = 30;
const DIAS_PREGUNTAS = 60;

// ── Qué publicaciones mirar en detalle ─────────────────────────────────────────────────
// Sólo productos con stock: mejorar la publicación de algo que no se puede vender no sirve.
//   · no_convence → la gente entra y no compra: la peor conversión con visitas suficientes.
//   · no_aparece  → casi nadie la ve: pocas o ninguna visita, las de más stock primero.
//   · referencia  → las que mejor convierten, para copiar lo que les funciona.
function elegirCandidatas(conversion, productos, { noConvence = 12, noAparece = 8, referencia = 3 } = {}) {
  const porSku = new Map((productos || []).map(p => [p.sku, p]));
  const conStock = (conversion || [])
    .map(f => ({ ...f, stock: packsDisponibles(porSku.get(f.sku)?.stock_dep, porSku.get(f.sku)) }))
    .filter(f => f.stock > 0 && porSku.has(f.sku) && !porSku.get(f.sku).discontinuado);

  const medibles = conStock
    .filter(f => f.conversion != null && !f.pocas_visitas)
    .sort((a, b) => a.conversion - b.conversion || (b.visitas || 0) - (a.visitas || 0));
  const elegidas = [];
  const usadas = new Set();
  const sumar = (lista, motivo, n) => {
    for (const f of lista) {
      if (elegidas.filter(e => e.motivo === motivo).length >= n) break;
      if (usadas.has(f.sku)) continue;
      usadas.add(f.sku);
      elegidas.push({ ...f, motivo });
    }
  };
  sumar(medibles, 'no_convence', noConvence);
  sumar(conStock.filter(f => f.visitas == null || f.visitas === 0 || f.pocas_visitas)
    .sort((a, b) => b.stock - a.stock), 'no_aparece', noAparece);
  sumar([...medibles].reverse().filter(f => f.vendidas > 0), 'referencia', referencia);
  return elegidas;
}

// Lo que importa de una publicación para mejorarla, sin el peso de la respuesta de MELI.
function resumirItem(item, visitas) {
  const atributos = (item.attributes || [])
    .filter(a => a && a.value_name)
    .map(a => ({ nombre: a.name || a.id, valor: a.value_name }));
  return {
    meli_id: item.id,
    titulo: item.title,
    largo_titulo: (item.title || '').length,
    precio: item.price,
    estado: item.status,
    vendidos: item.sold_quantity ?? null,
    tipo: item.listing_type_id || null,
    catalogo: !!item.catalog_listing,
    condicion: item.condition || null,
    envio_gratis: !!item.shipping?.free_shipping,
    logistica: item.shipping?.logistic_type || null,
    fotos: (item.pictures || []).length,
    atributos_cargados: atributos.length,
    atributos: atributos.slice(0, 25),
    salud: item.health ?? null,
    visitas_30d: visitas ?? null,
  };
}

// Las preguntas agrupadas por producto del CRM (por cualquiera de sus publicaciones).
function agruparPreguntas(preguntas, productos, titulos = {}) {
  const dueño = new Map();
  for (const p of productos || []) for (const id of meliIdsDe(p)) dueño.set(id, p);

  const grupos = new Map();
  const sueltas = new Map();
  for (const q of preguntas || []) {
    const p = dueño.get(q.item_id);
    const fila = { fecha: q.fecha, pregunta: q.texto, respuesta: q.respuesta, estado: q.estado };
    if (p) {
      const g = grupos.get(p.sku) || { sku: p.sku, nombre: p.nombre, preguntas: [] };
      g.preguntas.push(fila);
      grupos.set(p.sku, g);
    } else {
      const g = sueltas.get(q.item_id) || { item_id: q.item_id, titulo: titulos[q.item_id] || null, preguntas: [] };
      g.preguntas.push(fila);
      sueltas.set(q.item_id, g);
    }
  }
  const porCantidad = (a, b) => b.preguntas.length - a.preguntas.length;
  return {
    por_producto: [...grupos.values()].sort(porCantidad),
    sin_vincular: [...sueltas.values()].sort(porCantidad),
  };
}

const ok = datos => ({ ok: true, datos, error: null });

const PARTES = {
  async conversion() {
    const r = await invocar(require('./meli/conversion'), { query: { dias: String(DIAS_CONVERSION) } });
    return resultado(r.data, [r]);
  },

  async angulos() {
    const r = await invocar(require('./meli/angulos'));
    const d = r.data;
    const datos = d?.ok
      ? aligerar({ objetivo: d.objetivo, productos: d.productos, sin_tabla: d.sin_tabla })
      : d;
    return resultado(datos, [r]);
  },

  async fotos() {
    const r = await invocar(require('./meli/fotos'));
    const d = r.data;
    const datos = d?.ok
      ? aligerar({ resumen: d.resumen, productos: (d.productos || []).filter(p => p.distintas > 0) })
      : d;
    return resultado(datos, [r]);
  },

  async publicaciones({ supabase, fecha }) {
    const { data: guardada } = await supabase.from(TABLA)
      .select('ok, datos').eq('fecha', fecha).eq('parte', 'conversion').maybeSingle();
    if (!guardada?.ok || !guardada.datos?.productos) {
      return { ok: false, datos: null, error: 'Falta la parte conversion de este día (corre antes).' };
    }

    const { data: productos, error } = await supabase.from('productos')
      .select('sku, nombre, precio, stock_dep, unidades_por_venta, discontinuado, meli_id, meli_ids');
    if (error) throw error;
    const candidatas = elegirCandidatas(guardada.datos.productos, productos);
    const porSku = new Map(productos.map(p => [p.sku, p]));

    const { getMeliToken } = require('./_meliToken');
    const { meliFetch } = require('./_meliPublicaciones');
    const { traerVisitas } = require('./meli/conversion');
    const { rango } = require('./meli/_conversion');
    const token = await getMeliToken();

    const ids = [...new Set(candidatas.flatMap(c => meliIdsDe(porSku.get(c.sku))))];
    const items = {};
    const atributos = 'id,title,price,status,sold_quantity,listing_type_id,catalog_listing,condition,shipping,pictures,attributes,health';
    for (let i = 0; i < ids.length; i += 20) {
      const r = await meliFetch(token, `/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=${atributos}`);
      for (const e of [].concat(r.ok ? r.data : [])) if (e?.code === 200 && e.body?.id) items[e.body.id] = e.body;
    }
    const visitas = await traerVisitas(token, ids, { ...rango(DIAS_CONVERSION), dias: DIAS_CONVERSION });

    // La descripción de la publicación principal: ahí van las respuestas a lo que se pregunta.
    const descripciones = {};
    await Promise.all(candidatas.map(async c => {
      const principal = meliIdsDe(porSku.get(c.sku))[0];
      if (!principal) return;
      const r = await meliFetch(token, `/items/${principal}/description`);
      if (r.ok) descripciones[c.sku] = String(r.data?.plain_text || '').slice(0, 1500);
    }));

    return ok({
      dias: DIAS_CONVERSION,
      candidatas: candidatas.map(c => ({
        sku: c.sku,
        nombre: c.nombre,
        motivo: c.motivo,
        precio_crm: porSku.get(c.sku)?.precio ?? null,
        stock: c.stock,
        visitas: c.visitas,
        vendidas: c.vendidas,
        conversion_pct: c.conversion == null ? null : Math.round(c.conversion * 10000) / 100,
        fotos_nuevas: c.fotos_nuevas,
        descripcion: descripciones[c.sku] ?? null,
        publicaciones: meliIdsDe(porSku.get(c.sku))
          .map(id => items[id] ? resumirItem(items[id], visitas[id]) : { meli_id: id, sin_dato: true }),
      })),
    });
  },

  async preguntas({ supabase, fecha }) {
    const { getMeliToken } = require('./_meliToken');
    const { getSellerId, listarRecientes, titulosDeItems } = require('./_meliPreguntas');
    const token = await getMeliToken();
    const desde = sumarDias(fecha, -DIAS_PREGUNTAS);
    const preguntas = await listarRecientes(token, await getSellerId(token), { desde, max: 300 });

    const { data: productos, error } = await supabase.from('productos')
      .select('sku, nombre, meli_id, meli_ids');
    if (error) throw error;
    const vinculadas = new Set(productos.flatMap(meliIdsDe));
    const titulos = await titulosDeItems(token, preguntas.map(q => q.item_id).filter(id => !vinculadas.has(id)));
    return ok({ desde, total: preguntas.length, ...agruparPreguntas(preguntas, productos, titulos) });
  },
};

async function correrParte(supabase, parte, ahora = new Date()) {
  const fecha = hoyEnUruguay(ahora);
  return correrYGuardar({
    supabase, tabla: TABLA, partes: PARTES, parte, clave: { fecha }, contexto: { supabase, fecha },
  });
}

module.exports = { TABLA, PARTES, elegirCandidatas, resumirItem, agruparPreguntas, correrParte };
