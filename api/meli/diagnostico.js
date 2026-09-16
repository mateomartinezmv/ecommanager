// api/meli/diagnostico.js
// GET /api/meli/diagnostico?sku=XXX
//
// Sólo lectura: no crea ni modifica nada. Prueba el mismo cuerpo que usaría un ángulo con
// distintas configuraciones de envío contra POST /items/validate —que valida sin publicar—
// y devuelve cuál acepta MELI. Sirve para saber qué envío soporta la cuenta hoy en vez de
// deducirlo del ítem viejo, que puede estar en un modo que MELI ya dio de baja.

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');
const { meliIdsDe } = require('../_meliIds');
const {
  meliGet,
  obtenerItem,
  maxTitulo,
  detectarModoTitulo,
  construirPayload,
  validarPayload,
  limpiarTitulo,
} = require('../_meliPublicaciones');

// Variantes de envío a probar, de la más fiel al original a la más neutra.
const VARIANTES = [
  { nombre: 'como la original', ajuste: (p, item) => { if (item.shipping) p.shipping = { mode: item.shipping.mode, local_pick_up: !!item.shipping.local_pick_up, free_shipping: !!item.shipping.free_shipping }; } },
  { nombre: 'sin el modo', ajuste: (p, item) => { p.shipping = { local_pick_up: !!item.shipping?.local_pick_up, free_shipping: !!item.shipping?.free_shipping }; } },
  { nombre: 'sin retiro en persona', ajuste: (p, item) => { p.shipping = { local_pick_up: false, free_shipping: !!item.shipping?.free_shipping }; } },
  { nombre: 'sin bloque de envío', ajuste: (p) => { delete p.shipping; } },
  { nombre: 'mode me2', ajuste: (p) => { p.shipping = { mode: 'me2', local_pick_up: false, free_shipping: false }; } },
  { nombre: 'mode not_specified', ajuste: (p) => { p.shipping = { mode: 'not_specified', local_pick_up: false, free_shipping: false }; } },
  { nombre: 'mode custom', ajuste: (p) => { p.shipping = { mode: 'custom', local_pick_up: false, free_shipping: false }; } },
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Sólo GET' });

  try {
    const token = await getMeliToken();
    const supabase = getSupabase();
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'Falta ?sku=' });

    const { data: producto } = await supabase
      .from('productos').select('sku, nombre, stock_dep, meli_id, meli_ids').eq('sku', sku).single();
    if (!producto) return res.status(404).json({ ok: false, error: `No existe el SKU ${sku}` });

    const ids = meliIdsDe(producto);
    if (!ids.length) return res.status(400).json({ ok: false, error: `${sku} no tiene publicaciones enlazadas` });

    const usuario = await meliGet(token, '/users/me');
    const item = await obtenerItem(token, ids[0]);
    const modoTitulo = detectarModoTitulo(item, usuario);
    const max = await maxTitulo(token, item.category_id);

    // Un título cualquiera pero válido: lo que se está probando es el envío.
    const titulo = limpiarTitulo(`${item.family_name || item.title} Prueba`, max);
    const base = () => construirPayload(item, {
      titulo, sku: producto.sku, stock: Math.max(1, producto.stock_dep || 1), giroFotos: 1, modoTitulo,
    });

    const pruebas = [];
    for (const v of VARIANTES) {
      const payload = base();
      v.ajuste(payload, item);
      const r = await validarPayload(token, payload);
      pruebas.push({
        variante: v.nombre,
        envio_enviado: payload.shipping || null,
        acepta: r.valida,
        error: r.errores?.[0] || null,
      });
    }

    return res.json({
      ok: true,
      sku: producto.sku,
      vendedor: {
        id: usuario.id,
        tags: usuario.tags || [],
        // Lo que MELI dice que la cuenta puede usar, si lo expone.
        shipping_modes: usuario.shipping_modes || null,
      },
      original: {
        meli_id: item.id,
        titulo: item.title,
        family_name: item.family_name || null,
        user_product_id: item.user_product_id || null,
        listing_type_id: item.listing_type_id,
        category_id: item.category_id,
        shipping: item.shipping || null,
        tags: item.tags || [],
      },
      modo_titulo: modoTitulo,
      pruebas,
    });
  } catch (err) {
    console.error('Error en /api/meli/diagnostico:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
