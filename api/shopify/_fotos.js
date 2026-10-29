// api/shopify/_fotos.js
// Qué fotos de MELI le faltan a cada producto de la tienda, sin tocar MELI ni Shopify.
//
// Las fotos del producto viven en MELI: ahí se suben, se reordenan y se cambian. La tienda
// se cargó en su momento desde MELI y de ahí en más se quedó con lo que había ese día, así
// que un producto puede tener en Shopify menos fotos que en MELI, o ninguna.
//
// La referencia es la publicación principal (meli_ids[0]), igual que en meli/_fotos.js.
//
// Lo que se agrega nunca pisa lo que ya está: una foto que se subió a mano a la tienda se
// queda. Y lo que ya está no se vuelve a subir: Shopify guarda la imagen con el nombre del
// archivo original, que en las fotos de MELI lleva adentro la clave de la imagen
// ("…/files/D_NQ_NP_2X_782955-MLM77584366740_072024-F.webp"), así que se puede reconocer
// una foto de MELI ya cargada aunque Shopify la haya republicado en su CDN y en otro formato.

// La clave de una foto de MELI dentro de cualquier url que la contenga, o '' si no es una.
// El tramo del sitio es MLU, MLM, MLA… pero también CBT en las publicaciones internacionales.
function claveImagen(url) {
  const m = String(url || '').match(/(\d+-[A-Z]{3}\d+_\d+)/);
  return m ? m[1] : '';
}

// Las fotos de MELI que todavía no están en la tienda, en el orden en que las muestra MELI.
// `fotosMeli` son { id, url } (meli/_fotos.js fotosDe); `imagenesShopify` son urls.
function fotosFaltantes(fotosMeli, imagenesShopify) {
  const cargadas = new Set((imagenesShopify || []).map(claveImagen).filter(Boolean));
  const vistas = new Set();
  const faltan = [];
  for (const f of fotosMeli || []) {
    if (!f?.url) continue;
    const clave = claveImagen(f.url) || claveImagen(f.id) || f.url;
    if (cargadas.has(clave) || vistas.has(clave)) continue;
    vistas.add(clave);
    faltan.push(f);
  }
  return faltan;
}

// Arma el plan por producto de Shopify. Varios SKUs del CRM pueden ser variantes del mismo
// producto (un color por SKU): las fotos de todos se juntan en un solo producto, sin repetir.
//
// `productos`: [{ sku, nombre, variantId, original }] donde original es la publicación de
//              MELI con sus fotos (o null si no se pudo leer).
// `shopify`:   { [variantId]: { productId, titulo, imagenes: [url] } } (falta si la variante
//              ya no existe en la tienda).
function armarPlan(productos, shopify) {
  const porProducto = new Map();
  const sinResolver = [];

  for (const p of productos || []) {
    const s = shopify?.[p.variantId];
    if (!s) { sinResolver.push({ sku: p.sku, nombre: p.nombre, motivo: 'La variante enlazada ya no existe en Shopify.' }); continue; }
    if (!p.original?.fotos?.length) { sinResolver.push({ sku: p.sku, nombre: p.nombre, motivo: 'No se pudieron leer fotos de la publicación de MELI.' }); continue; }

    if (!porProducto.has(s.productId)) {
      porProducto.set(s.productId, {
        productId: s.productId,
        titulo: s.titulo,
        skus: [],
        meli_ids: [],
        imagenes: s.imagenes || [],
        faltan: [],
      });
    }
    const fila = porProducto.get(s.productId);
    fila.skus.push(p.sku);
    fila.meli_ids.push(p.original.meli_id);
    // Lo que ya se planeó subir para otro SKU del mismo producto cuenta como cargado.
    const yaPlaneadas = fila.faltan.map(f => f.url);
    fila.faltan.push(...fotosFaltantes(p.original.fotos, [...fila.imagenes, ...yaPlaneadas]));
  }

  return { productos: [...porProducto.values()], sinResolver };
}

module.exports = { claveImagen, fotosFaltantes, armarPlan };
