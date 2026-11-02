// api/shopify/_descuentos.js
// Lógica pura de /api/shopify/descuentos: qué precio y qué "precio de comparación" tiene que
// tener cada variante de Shopify para mostrar el mismo descuento que está corriendo en MELI.
//
// La regla:
//   · compare_at_price = precio de lista de MELI (el precio sin descuento)
//   · price            = precio final de MELI (con el descuento)
//   · Si un SKU tiene varias publicaciones con descuento (la original y sus ángulos) y cada
//     una quedó a un precio final distinto, manda la de precio final MÁS ALTO.
//   · Un SKU sin ningún descuento activo en MELI no se toca.

// Shopify guarda los precios como texto con dos decimales; MELI como número.
function aCentavos(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function aTexto(valor) {
  const c = aCentavos(valor);
  return c === null ? null : (c / 100).toFixed(2);
}

// El descuento que se copia a Shopify, entre todas las publicaciones de un SKU. Sólo cuentan
// las activas que tienen un descuento corriendo (descuento.precio < precio de lista).
function descuentoDelSku(publicaciones) {
  const conDescuento = (publicaciones || []).filter(p =>
    p && p.estado === 'active' && p.descuento &&
    Number(p.descuento.precio) > 0 &&
    Number(p.descuento.precio) < Number(p.descuento.precio_lista)
  );
  if (!conDescuento.length) return null;

  // El precio final más alto; si empatan, la publicación que venga primero (la principal).
  const elegida = conDescuento.reduce((mejor, p) =>
    aCentavos(p.descuento.precio) > aCentavos(mejor.descuento.precio) ? p : mejor
  );

  const precios = [...new Set(conDescuento.map(p => aCentavos(p.descuento.precio)))];
  return {
    meli_id: elegida.meli_id,
    nombre: elegida.descuento.nombre || elegida.descuento.tipo || null,
    tipo: elegida.descuento.tipo || null,
    finish_date: elegida.descuento.finish_date || null,
    precio: aTexto(elegida.descuento.precio),
    precio_lista: aTexto(elegida.descuento.precio_lista),
    porcentaje: Math.round((1 - elegida.descuento.precio / elegida.descuento.precio_lista) * 100),
    // Para avisar que las publicaciones del SKU no estaban parejas en MELI.
    publicaciones_con_descuento: conDescuento.length,
    precios_distintos: precios.length > 1,
  };
}

// Arma el plan: por cada producto (SKU enlazado a una variante de Shopify), qué precio
// tiene hoy en la tienda y cuál tendría que tener.
//   productos: [{ sku, nombre, variantId, publicaciones: [...] }]
//   shopify:   { [variantId]: { productId, titulo, variante, precio, compare_at } }
function armarPlan(productos, shopify) {
  const filas = [];
  const sinShopify = [];

  for (const p of productos || []) {
    const descuento = descuentoDelSku(p.publicaciones);
    if (!descuento) continue;

    const v = shopify?.[String(p.variantId)];
    if (!v) {
      sinShopify.push({ sku: p.sku, nombre: p.nombre, variantId: p.variantId || null, descuento });
      continue;
    }

    const actual = { precio: aTexto(v.precio), compare_at: aTexto(v.compare_at) };
    const nuevo = { precio: descuento.precio, compare_at: descuento.precio_lista };
    filas.push({
      sku: p.sku,
      nombre: p.nombre,
      variantId: String(p.variantId),
      productId: v.productId || null,
      titulo_shopify: v.titulo || null,
      variante: v.variante || null,
      descuento,
      actual,
      nuevo,
      alDia: actual.precio === nuevo.precio && actual.compare_at === nuevo.compare_at,
    });
  }

  return { filas, sinShopify };
}

module.exports = { descuentoDelSku, armarPlan, aTexto };
