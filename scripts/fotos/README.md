# Reemplazar las fotos de un producto en MELI y Shopify

Sube un juego nuevo de fotos y reemplaza con él las que tiene el producto, en **todas
sus publicaciones de MELI** (todos los ángulos de venta) y en **Shopify**, sin tocar los
otros colores.

## Cómo se usa

Las fotos van en una carpeta con el nombre del SKU, numeradas en el orden en que se
quieren mostrar. **La primera es la portada.**

```
scripts/fotos/HP-Q0211/
  01-portada-par-guardamanos.jpg
  02-par-con-abrazaderas.jpg
  03-medidas-33x11.jpg
  04-kit-completo-herrajes.jpg
  05-par-con-detalle-instalado.jpg
```

```bash
# 1) Mirar qué haría, sin tocar nada (esto es lo que hace por defecto)
node scripts/fotos/reemplazar-fotos.js --sku HP-Q0211

# 2) Recién cuando el plan convence
node scripts/fotos/reemplazar-fotos.js --sku HP-Q0211 --aplicar
```

| Opción | Para qué |
|---|---|
| `--sku HP-Q0211` | Qué producto del CRM. Por defecto `HP-Q0211`. |
| `--fotos <carpeta>` | Otra carpeta de fotos. Por defecto `scripts/fotos/<SKU>`. |
| `--aplicar` | Escribe de verdad. Sin esto es simulacro. |
| `--solo-meli` / `--solo-shopify` | Una plataforma sola. |
| `--borrar 123,456` | Fotos viejas de la galería de Shopify a borrar (ver abajo). |
| `--portada-producto` | Que la foto 1 pase a ser la portada del producto en Shopify. Ojo: es común a los tres colores. |

Credenciales: las mismas que usa la app, en `.env.local` o en el entorno —
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MELI_CLIENT_ID`, `MELI_CLIENT_SECRET`,
`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`.

## Qué hace en MELI

Sube las fotos **una sola vez** a la cuenta (los `picture_id` de MELI sirven para
cualquier publicación del vendedor) y después las aplica a cada publicación de
`productos.meli_ids`. La foto 1 queda de portada en todas.

- Publicación **sin variaciones** → se reemplaza la galería entera.
- Publicación **con variaciones de color** → se tocan sólo las fotos de la variación
  cuyo color coincide con el del SKU (sale del nombre del producto, `… - Negro`). Las
  fotos de los otros colores se conservan en la galería del ítem. Si ninguna variación
  coincide, o coincide más de una, esa publicación se saltea con un aviso: no se adivina.
- Publicación **de catálogo** → se saltea con aviso. MELI usa las fotos de la ficha de
  catálogo y no deja cambiarlas desde la publicación.
- Publicación **cerrada** → se saltea.

Después de cada cambio vuelve a leer el ítem y verifica que la portada haya quedado
en la foto 1.

## Qué hace en Shopify (y qué no)

En esta tienda los tres colores (Negro / Azul / Rojo) son **variantes de un solo
producto** y comparten **una sola galería**. Shopify no reparte la galería por color:

- cada variante apunta a **una única** foto suya (`variant.image_id`),
- y todo el resto de la galería se le muestra igual a quien esté mirando cualquier color.

O sea que "las fotos de la variante Negro" no existen como conjunto. Por eso el script:

1. sube las fotos nuevas a la galería del producto,
2. pone la foto 1 como foto de la variante del SKU,
3. borra la que era la foto de esa variante —**ese es el reemplazo**—,
4. y no borra nada más por las suyas.

Las fotos que no están asignadas a ninguna variante no se pueden atribuir a un color
desde la API, así que el script **las lista y no las toca**. Si alguna es una foto vieja
de este SKU, se pasa a mano: `--borrar 5001,5006`. Una foto que es de otro color nunca se
borra, aunque se la pase por `--borrar`.

La portada del producto (posición 1 de la galería) es la miniatura que se ve en el
catálogo, común a los tres colores, así que **no se toca** salvo que se pida con
`--portada-producto`.

Al terminar verifica que las fotos de los otros colores hayan quedado como estaban.

## Sobre las fotos

MELI pide **mínimo 500 × 500** y recomienda 1200 × 1200, fondo blanco. Conviene dejarlas
cuadradas y en JPG antes de subirlas: se recortan solas si no lo están, y la portada es
lo que define el click.
