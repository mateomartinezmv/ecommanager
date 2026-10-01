# Precio contado en la web (Shopify — Martínez Motos)

Muestra, debajo del precio de lista, el **precio pagando con transferencia o efectivo**
(10% off por defecto, configurable desde el theme editor sin tocar código).

```
  Parabrisas HP-DF028
  $45.990
  ┌────────────────────────────────────────────────┐
  │ $41.390  pagando con transferencia o efectivo  │
  │          · 10% off · Ver cómo                  │
  └────────────────────────────────────────────────┘
```

## Archivos

| Archivo | Va en el theme como |
|---|---|
| `snippets/precio-contado.liquid` | `snippets/precio-contado.liquid` |
| `assets/precio-contado.css` | pegar al final de `assets/base.css` |

## Instalación

Probar siempre sobre una **copia del theme** (Online Store → Themes → ⋯ → Duplicate),
publicar recién cuando se vea bien.

### 1. Subir el snippet

Online Store → Themes → ⋯ → **Edit code** → `snippets` → **Add a new snippet** →
nombre `precio-contado` → pegar el contenido de `snippets/precio-contado.liquid`.

### 2. Estilos

Abrir `assets/base.css` y pegar al final el contenido de `assets/precio-contado.css`.

### 3. Mostrarlo (ficha de producto + grilla, de una sola vez)

En `snippets/price.liquid`, **justo antes del `</div>` final** (el que cierra `div.price`):

```liquid
  {%- endif -%}
  {%- if main_price -%}
    {%- render 'precio-contado', product: product, destacado: true -%}
  {%- elsif hide_currency_code -%}
    {%- render 'precio-contado', product: product, compacto: true -%}
  {%- endif -%}
</div>
```

> **Por qué acá y no en `main-product.liquid` / `card-product.liquid`:** el bloque tiene que
> quedar **adentro** del elemento de precio. El theme re-renderiza ese elemento cuando el
> cliente cambia de variante (y los swatches de las tarjetas lo actualizan por JS); si el
> bloque queda como hermano, se congela mostrando el precio de la primera variante.
>
> `main_price` lo pasa el bloque de precio de la ficha de producto (versión destacada).
> `hide_currency_code` lo pasan las tarjetas de producto (versión compacta). Los line items
> del carrito no usan este snippet, usan `item.final_line_price`.

### 5. Controles en el theme editor

En `config/settings_schema.json`, agregar este objeto al final del array (antes del `]` final,
con una coma después del objeto anterior):

```json
{
  "name": "Precio contado",
  "settings": [
    {
      "type": "range",
      "id": "precio_contado_pct",
      "label": "Descuento contado",
      "min": 0, "max": 30, "step": 1, "default": 10, "unit": "%"
    },
    {
      "type": "range",
      "id": "precio_contado_redondeo",
      "label": "Redondear hacia abajo a múltiplos de ($)",
      "min": 0, "max": 500, "step": 10, "default": 10
    },
    {
      "type": "text",
      "id": "precio_contado_texto",
      "label": "Leyenda",
      "default": "pagando con transferencia o efectivo"
    },
    {
      "type": "url",
      "id": "precio_contado_link",
      "label": "Página con las condiciones"
    }
  ]
}
```

Queda en Theme editor → **Theme settings → Precio contado**. Cambiar el 10% es un slider.

### 6. Excluir productos puntuales

Settings → **Custom data** → Products → Add definition:
nombre `Sin precio contado`, namespace y key `custom.sin_precio_contado`, tipo **True/False**.
Poniéndolo en `true` en un producto, el bloque no aparece para ese producto.

## Que el descuento se cumpla de verdad en el checkout

El snippet **solo muestra** el precio. Para que el cliente lo pague online:

1. Settings → Payments → **Manual payment methods** → *Bank Deposit*: alias/CBU en las
   instrucciones. Costo de pasarela 0%; la orden entra como *Pending*.
2. Discounts → **Create discount** → código `CONTADO10`, 10%, sin mínimo, no combinable.
3. En el bloque de precio contado, apuntar `precio_contado_link` a una página
   "Cómo pagar con transferencia" que explique el flujo y muestre el código.

**Límite real:** Shopify no puede condicionar un descuento al medio de pago en el plan Basic
(eso es *payment customizations*, requiere Plus). Entonces alguien podría usar `CONTADO10`
y pagar con tarjeta. Con el volumen actual de la web el control es manual y trivial: antes de
despachar, mirar el medio de pago de la orden; si no es transferencia, pedir la diferencia o
cancelar. Si la web crece, hay apps de "descuento por medio de pago" que lo cierran solo.

## Por qué conviene darlo también con envío

Números reales del CRM (tabla `ventas`, 491 ventas MELI):

| Canal | Lo que entra de cada $100 (UYU) |
|---|---|
| Mercado Libre (precio lleno) | **$85,30** — comisión 14,7% |
| Web, tarjeta 1 pago | ~$94 |
| Web, transferencia **con 10% off** | **$90** |
| Web, cuotas sin interés con 10% off | puede quedar bajo $70 |

El 10% contado en la web propia deja **~5 puntos más** que vender al precio lleno en MELI.
Por eso conviene que valga también para pedidos con envío, no solo para retiro en el local:
el envío se cobra aparte y la ganancia sigue siendo mejor que la de MELI.

La excepción es **cuotas sin interés**: ahí el costo financiero ya se come el margen y el 10%
encima lo da vuelta. El precio de lista tiene que ser el precio financiado, y el contado el
descuento sobre ese.

## Descuento automático al elegir la forma de pago

El cliente nunca tipea un código. En el carrito elige "Transferencia o efectivo"
y el total baja al instante.

| Archivo | Rol |
|---|---|
| `snippets/precio-contado-carrito.liquid` | el selector + el JS |
| `sections/main-cart-footer.liquid` | +1 línea: `{% render 'precio-contado-carrito' %}` dentro de `div.cart__blocks` |

Mecanismo: `POST /cart/update.js` con `{attributes: {...}, discount: 'CONTADO10'}`.
El parámetro `discount` existe desde mayo 2025, y `cart.total_price` es el total
*después* de descuentos, así que el precio baja en el carrito y no solo en el checkout.
El atributo `Forma de pago` queda en la orden, así que ves en el admin qué eligió.

Requiere que exista el código **CONTADO10** (10%, todos los productos, sin mínimo).

### Dos límites que hay que tener presentes

**`{discount: ''}` borra TODOS los descuentos del carrito.** Al elegir "tarjeta" se
limpia cualquier otro código que el cliente tuviera puesto. Mientras no corras otra
promo por código en la web, no molesta.

**El código es visible en el HTML.** Cualquiera que mire el fuente lo puede usar sin
elegir transferencia. No es grave (el 10% es justamente para quien paga así), pero
significa que esto **no es un candado**: hay que mirar el medio de pago de la orden
antes de despachar. El candado de verdad necesita dos Shopify Functions
(descuento + ocultar medios de pago), que corren en plan Basic pero van dentro de una
app custom desplegada con Shopify CLI.

### Por qué el precio exhibido NO se redondea

`paso_pesos = 0` en `precio-contado.liquid`, a propósito. El descuento del checkout es
10% exacto; si la ficha redondeara a múltiplos de $10 ($1.490 → $1.340) se exhibiría
$1 menos de lo que se cobra ($1.341). Lo exhibido tiene que ser lo cobrado.

### OJO: el carrito de esta tienda es un drawer

`settings_data.json` tiene `"cart_type": "drawer"`. El selector está en
`main-cart-footer.liquid`, que es la página `/cart` — con drawer activo, el cliente
llega ahí solo si hace clic en "ver carrito". Para que lo vea en el camino principal,
una de dos:

- **Theme settings → Cart → cart type = `page`.** Un desplegable. Se pierde el drawer
  (y sus upsells, timer y barra de envío gratis, que están configurados).
- **Meterlo también en el drawer:** `snippets/cart-drawer.liquid` son 53KB y
  `sections/cart-drawer.liquid` 95KB. Se puede, pero es el archivo más complejo del
  theme y una actualización de Shrine se lo lleva.

## Tests

`tests/` corre los snippets contra un motor Liquid real con los precios de la tienda:

```bash
npm install liquidjs
node tests/test-producto.js   # ficha y grilla
node tests/test-carrito.js    # selector del carrito
```

Ahí salió el bug del redondeo: el código daba por sentado que `divided_by` trunca con
enteros (cierto en Shopify, pero implícito) y devolvía el precio sin redondear.
