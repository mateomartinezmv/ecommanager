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
