# Cruce Shopify ↔ MELI por SKU del CRM

Carga en Shopify los productos que ya están publicados en MELI y todavía no estaban
en la tienda. El cruce es **por SKU del CRM**, nunca por nombre: el mismo producto
tiene en MELI varios títulos distintos (los ángulos de venta), así que cruzar por
nombre devuelve falsos faltantes.

## De dónde sale cada dato

| Dato | Fuente |
|---|---|
| Productos ya cargados en la tienda | `products_export_original.csv` (export de Shopify de MARTINEZ MOTOS) |
| SKU, precio, costo, stock de depósito | tabla `productos` del CRM (Supabase) |
| Publicaciones de cada SKU | `productos.meli_ids` + `SELLER_SKU`/`seller_custom_field` de la API de MELI |
| Ventas históricas por publicación | `sold_quantity` de la API de MELI, validado contra la tabla `ventas` del CRM |
| Título, fotos y ficha | la publicación del ángulo elegido |

El cruce se corrió contra la cuenta `MARTINEZMOTOSOK` (user `2715667241`, sitio MLU):
163 publicaciones, 59 SKUs distintos.

## Qué ángulo se elige

Un SKU puede tener varias publicaciones apuntando a distintas formas de buscar el
producto. Se toma **la que más unidades vendió en toda su historia**, porque es la
que probó convertir. Desempates, en este orden:

1. más unidades vendidas;
2. si empatan, la publicación principal del CRM (`meli_ids[1]`);
3. si ninguna es la principal, la de la venta más reciente.

## Reglas del armado

- Los extensores de espejo con rosca (`EXT-ESP-*`) no están en MELI y quedan afuera.
- Un SKU que ya está en la tienda no se duplica. Si está cargado sin `Variant SKU`,
  se le completa el SKU (caso `ALERONFINOSNK`).
- Un producto que ya está en la tienda se puede reemplazar por su publicación de
  MELI (lista `SUSTITUCIONES`, caso `HP-DF028`). **El handle no cambia**: Shopify
  reconoce el producto por el handle, no por el SKU, así que conservarlo es lo que
  hace que la importación actualice el producto en vez de crear otro, y de paso
  mantiene la URL y el SEO ya ganados. Proveedor, categoría, tipo, tags y peso se
  respetan tal cual estaban; el resto se reescribe con lo que hay en MELI.
- Un color nuevo de un producto que ya existe entra como variante de ese handle, no
  como producto aparte (`DOM04`, `PUNYELLOW`).
- Los títulos vienen del ángulo ganador; el cuerpo se redacta en el formato de las
  fichas de la tienda (¿Qué es? / ¿Para qué sirve? / ¿Cómo se instala?).
- `Variant Inventory Qty` sale de `productos.stock_dep` y `Cost per item` de
  `productos.costo`.

## Uso

```sh
python3 generar-csv-faltantes-shopify.py   # → products_export_actualizado.csv
python3 informe-cruce-shopify-meli.py      # → informe-cruce.csv
```

`products_export_actualizado.csv` se importa en Shopify desde
**Productos → Importar**, marcando *Sobrescribir productos existentes que tengan el
mismo handle*. Las fotos de los productos nuevos apuntan al CDN de MELI
(`http2.mlstatic.com`); Shopify las descarga y las republica en su propio CDN
durante la importación.

Al reemplazar un producto conviene revisar la galería en el admin después de
importar: el importador no siempre borra las imágenes viejas que ya no están en el
CSV, y pueden quedar colgadas junto a las nuevas.

> **El stock del CSV pisa el de Shopify.** `Variant Inventory Qty` no es
> informativo: al importar, Shopify deja el inventario en ese número. La primera
> versión de este script copiaba la columna del export tal cual en los productos
> que ya existían, y al importarlo el guardabarros `HP-DB004-B` quedó en 0
> teniendo 11. Ahora el stock de todas las filas sale de `STOCK_CRM`, que es un
> volcado de `productos.stock_dep`. Si pasa tiempo entre que se genera el CSV y
> se importa, conviene refrescar esa tabla o correr después
> `POST /api/shopify/sync-stock`, que deja Shopify en lo que diga el CRM.

## Pendiente del lado de MELI

Se corrigen con `api/meli/corregir-sku.js`:

```
GET  /api/meli/corregir-sku                              → lista lo desalineado
POST /api/meli/corregir-sku { "todos": true }            → corrige todos los SKU
POST /api/meli/corregir-sku { "meliId": "MLU698507115", "titulo": "…" }
```

El endpoint escribe el SKU en los dos lados que MELI usa (`seller_custom_field` y
el atributo `SELLER_SKU`), porque corregir uno solo deja el panel mostrando el
viejo según por dónde se lo mire.

| Publicación | Qué corregir |
|---|---|
| `MLU698507115` | el título dice `Criuser`, va `Cruiser` (en el CRM y en el CSV ya está bien) |
| `MLU1245773482` | `SELLER_SKU` dice `SEÑAL02`, el SKU del CRM es `HP-Z0533` |
| `MLU1038770042` | `SELLER_SKU` dice `PUNORANG`, el SKU del CRM es `PUNORGANG` |
| `MLU1504441880`, `MLU1504441882` | `SELLER_SKU` dice `MAN-78-V3-PLA-001`, que no existe en el CRM; son ángulos de `MAN-78-V3-NEG-001` |

Ninguna rompe nada hoy: el CRM resuelve las ventas por `productos.meli_ids`, no por
la etiqueta `SELLER_SKU` de MELI, y las cuatro publicaciones están enlazadas. Sólo
confunden a quien mire la publicación, y a «Importar desde MELI», que sí lee esa
etiqueta.

## Para rehacerlo con datos frescos

Los datos de MELI están fijos en los scripts (fotos y ventas al 2026-10-01). Para
volver a correrlo hay que releer la API: `GET /users/2715667241/items/search` para
listar las publicaciones y `GET /items?ids=…&attributes=…` en lotes de 20 para
traer `sold_quantity`, `seller_custom_field`, `attributes` y `pictures`.
