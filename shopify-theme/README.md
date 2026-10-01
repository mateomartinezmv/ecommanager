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

### 3. Mostrarlo en la ficha de producto

En `sections/main-product.liquid`, buscar el bloque del precio (`when 'price'`). Queda así:

```liquid
{%- when 'price' -%}
  <div class="no-js-hidden" id="price-{{ section.id }}" role="status" {{ block.shopify_attributes }}>
    {%- render 'price', product: product, use_variant: true, show_badges: true, price_class: 'price--large' -%}
    {%- render 'precio-contado', product: product, destacado: true -%}
  </div>
```

> **Importante:** la línea nueva va **adentro** del `<div id="price-...">`. Dawn re-renderiza
> ese div cuando el cliente cambia de variante, así que el precio contado se actualiza solo.
> Si queda afuera, se congela en el precio de la primera variante.

### 4. Mostrarlo en la grilla de colecciones (opcional)

En `snippets/card-product.liquid`, después del `render 'price'`:

```liquid
{%- render 'price', product: card_product, price_class: '', show_compare_at_price: true -%}
{%- render 'precio-contado', product: card_product, compacto: true -%}
```

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

| Canal | Lo que entra de cada $100 |
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
