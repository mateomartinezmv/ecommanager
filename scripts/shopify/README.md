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

## Para rehacerlo con datos frescos

Los datos de MELI están fijos en los scripts (fotos y ventas al 2026-10-01). Para
volver a correrlo hay que releer la API: `GET /users/2715667241/items/search` para
listar las publicaciones y `GET /items?ids=…&attributes=…` en lotes de 20 para
traer `sold_quantity`, `seller_custom_field`, `attributes` y `pictures`.
