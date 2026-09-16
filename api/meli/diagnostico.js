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

// Experimentos: cada uno toca una cosa del cuerpo que usaría un ángulo, para ver cuál es la
// que MELI rechaza. Todos van contra /items/validate, que valida sin publicar.
const EXPERIMENTOS = [
  { nombre: 'el ángulo tal cual', ajuste: () => {} },
  { nombre: 'sin bloque de envío', ajuste: (p) => { delete p.shipping; } },
  { nombre: 'envío me2 sin retiro', ajuste: (p) => { p.shipping = { mode: 'me2', local_pick_up: false, free_shipping: false }; } },
  { nombre: 'precio x2', ajuste: (p) => { p.price = Math.round(p.price * 2); } },
  { nombre: 'precio x5', ajuste: (p) => { p.price = Math.round(p.price * 5); } },
  { nombre: 'precio 5000', ajuste: (p) => { p.price = 5000; } },
  { nombre: 'sin atributos copiados', ajuste: (p) => { p.attributes = p.attributes.filter(a => a.id === 'SELLER_SKU'); } },
  { nombre: 'sin garantía', ajuste: (p) => { delete p.sale_terms; } },
  { nombre: 'sin SKU propio', ajuste: (p) => { delete p.seller_custom_field; p.attributes = p.attributes.filter(a => a.id !== 'SELLER_SKU'); } },
  { nombre: 'una sola foto', ajuste: (p) => { p.pictures = p.pictures.slice(0, 1); } },
  { nombre: 'cantidad 1', ajuste: (p) => { p.available_quantity = 1; } },
  { nombre: 'listing_type free', ajuste: (p) => { p.listing_type_id = 'free'; } },
  { nombre: 'listing_type bronze', ajuste: (p) => { p.listing_type_id = 'bronze'; } },
  // La cuenta tiene el tag eshop (Mercado Shops). Si el ítem se valida también para el canal
  // de la tienda y ese canal no tiene envío configurado, MELI cae a me1 y falla.
  { nombre: 'channels marketplace', ajuste: (p) => { p.channels = ['marketplace']; } },
  { nombre: 'channels mshops', ajuste: (p) => { p.channels = ['mshops']; } },
  { nombre: 'channels marketplace + envío original', ajuste: (p, item) => {
      p.channels = ['marketplace'];
      p.shipping = { mode: item.shipping?.mode || 'me2', local_pick_up: !!item.shipping?.local_pick_up, free_shipping: !!item.shipping?.free_shipping };
    } },
  // Las preferencias de la cuenta mandan me2 obligatorio: probar con envío gratis, que es
  // lo que MELI agrega solo cuando el precio pasa el umbral.
  { nombre: 'me2 + envío gratis', ajuste: (p) => { p.shipping = { mode: 'me2', local_pick_up: false, free_shipping: true }; } },
  { nombre: 'me2 + envío gratis + precio 5000', ajuste: (p) => { p.price = 5000; p.shipping = { mode: 'me2', local_pick_up: false, free_shipping: true }; } },
  { nombre: 'sólo mode me2', ajuste: (p) => { p.shipping = { mode: 'me2' }; } },
  // La cuenta tiene envío gratis a todo el país por configuración y MELI se lo aplica al alta
  // aunque el cuerpo mande free_shipping false. ¿Hay forma de apagarlo explícitamente?
  { nombre: 'envío gratis apagado con free_methods vacío', ajuste: (p, item) => {
      p.shipping = { mode: 'me2', local_pick_up: !!item.shipping?.local_pick_up, free_shipping: false, free_methods: [] };
    } },
  { nombre: 'not_specified sin envío gratis', ajuste: (p) => {
      p.shipping = { mode: 'not_specified', free_shipping: false, free_methods: [] };
    } },
  { nombre: 'custom, paga el comprador', ajuste: (p) => {
      p.shipping = { mode: 'custom', local_pick_up: false, free_shipping: false, methods: [] };
    } },
  // Control: la publicación original tal cual, como si la estuviéramos creando de nuevo.
  // Si MELI tampoco la acepta, el problema no es lo que arma el clon sino la cuenta.
  { nombre: 'la original calcada', ajuste: (p, item) => {
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, {
        family_name: `${item.family_name} Prueba`,
        category_id: item.category_id,
        price: item.price,
        currency_id: item.currency_id,
        available_quantity: item.available_quantity || 1,
        buying_mode: item.buying_mode,
        condition: item.condition,
        listing_type_id: item.listing_type_id,
        pictures: (item.pictures || []).map(f => ({ source: f.secure_url || f.url })),
        attributes: (item.attributes || [])
          .filter(a => a.id !== 'ITEM_CONDITION')
          .map(a => (a.value_id ? { id: a.id, value_id: a.value_id, value_name: a.value_name } : { id: a.id, value_name: a.value_name })),
        sale_terms: (item.sale_terms || []).map(t => (t.value_id ? { id: t.id, value_id: t.value_id } : { id: t.id, value_name: t.value_name })),
        shipping: { mode: item.shipping?.mode, local_pick_up: !!item.shipping?.local_pick_up, free_shipping: !!item.shipping?.free_shipping },
      });
    } },
  // Sin las medidas del paquete: 112 cm de alto puede dejar al ítem fuera de ME2.
  { nombre: 'sin medidas del paquete', ajuste: (p) => { p.attributes = p.attributes.filter(a => !a.id.startsWith('SELLER_PACKAGE_')); } },
  { nombre: 'medidas chicas', ajuste: (p) => {
      p.attributes = p.attributes.filter(a => !a.id.startsWith('SELLER_PACKAGE_')).concat([
        { id: 'SELLER_PACKAGE_HEIGHT', value_name: '10 cm' },
        { id: 'SELLER_PACKAGE_WIDTH', value_name: '10 cm' },
        { id: 'SELLER_PACKAGE_LENGTH', value_name: '15 cm' },
        { id: 'SELLER_PACKAGE_WEIGHT', value_name: '300 g' },
      ]);
    } },
  { nombre: 'mínimo absoluto', ajuste: (p, item) => {
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, {
        family_name: 'Prueba De Validacion Soporte Generico',
        category_id: item.category_id,
        price: item.price,
        currency_id: item.currency_id,
        available_quantity: 1,
        buying_mode: 'buy_it_now',
        condition: 'new',
        listing_type_id: item.listing_type_id,
        pictures: [{ source: (item.pictures || [])[0]?.secure_url }],
      });
    } },
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
      titulo, sku: producto.sku, stock: Math.max(1, producto.stock_dep || 1), portada: 0, modoTitulo,
    });

    const pruebas = [];
    for (const e of EXPERIMENTOS) {
      const payload = base();
      e.ajuste(payload, item);
      const r = await validarPayload(token, payload);
      pruebas.push({
        experimento: e.nombre,
        acepta: r.valida,
        error: r.errores?.[0] || null,
      });
    }

    // El producto de usuario puede tener datos que el ítem no muestra (peso, dimensiones):
    // si el clon no los hereda, MELI no puede resolver el envío y cae a me1.
    // Qué modos de envío ofrece la cuenta, según MELI.
    let preferencias = null;
    for (const ruta of [`/users/${usuario.id}/shipping_preferences`, `/users/${usuario.id}/shipping_modes`, `/users/${usuario.id}/shipping_options`]) {
      try { preferencias = { ruta, data: await meliGet(token, ruta) }; break; }
      catch (e) { preferencias = { ruta, error: e.message }; }
    }

    let userProduct = null;
    if (item.user_product_id) {
      try { userProduct = await meliGet(token, `/user-products/${item.user_product_id}`); }
      catch (e) { userProduct = { error: e.message }; }
    }

    return res.json({
      ok: true,
      sku: producto.sku,
      cuerpo_del_clon: base(),
      preferencias_envio: preferencias,
      user_product: userProduct,
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
        channels: item.channels || null,
        attributes: (item.attributes || []).map(a => ({ id: a.id, value_id: a.value_id ?? null, value_name: a.value_name ?? null })),
        sale_terms: item.sale_terms || [],
      },
      modo_titulo: modoTitulo,
      pruebas,
    });
  } catch (err) {
    console.error('Error en /api/meli/diagnostico:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
