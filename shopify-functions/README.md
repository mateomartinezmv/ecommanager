# Ocultar tarjeta cuando el cliente elige contado

Cierra el agujero del precio contado: si el carrito dice "Transferencia o efectivo"
(y por lo tanto ya tiene el 10% aplicado), el checkout **no muestra tarjeta de
crédito ni ningún wallet**. No se puede llevar el descuento y pagar con tarjeta.

## Cómo encaja con el theme

```
theme: snippets/precio-contado-carrito.liquid
   │  el cliente elige "Transferencia o efectivo"
   │  POST /cart/update.js  →  attributes["Forma de pago"] + discount CONTADO10
   ▼
Shopify Function (esto)
      lee cart.attribute(key: "Forma de pago")
      oculta todo medio de pago que no sea transferencia o efectivo
```

El atributo tiene que coincidir exactamente entre los dos lados. Si cambiás el
texto en el snippet, cambialo en `src/cart_payment_methods_transform_run.js`.

## Archivos

| Archivo | Qué es |
|---|---|
| `src/cart_payment_methods_transform_run.graphql` | el input de la función (validado contra el schema real) |
| `src/cart_payment_methods_transform_run.js` | la lógica |
| `src/cart_payment_methods_transform_run.test.mjs` | tests, corren con node sin instalar nada |

```bash
node shopify-functions/src/cart_payment_methods_transform_run.test.mjs
```

## Deploy

Hace falta cuenta de Shopify Partner y el CLI. **No scaffoldees a mano**: dejá que
el CLI genere la extensión (el TOML y el build cambian según la versión del CLI) y
después reemplazá solamente los dos archivos de `src/`.

Requisitos: **Node.js 22.12+**, **Git 2.28+** y el CLI (`npm install -g @shopify/cli@latest`).
Paso a paso detallado para Windows en [DEPLOY.md](DEPLOY.md).

```bash
# 1. Crear la app (una sola vez). Elegí la plantilla de React Router.
shopify app init
cd martinez-motos-pagos

# 2. Generar la extensión. Cuando pregunte el lenguaje, elegí JavaScript.
shopify app generate extension --template payment_customization --name ocultar-tarjeta-contado

# 3. Reemplazar los dos archivos generados por los de este repo
cp /ruta/a/ecommanager/shopify-functions/src/cart_payment_methods_transform_run.graphql \
   extensions/ocultar-tarjeta-contado/src/
cp /ruta/a/ecommanager/shopify-functions/src/cart_payment_methods_transform_run.js \
   extensions/ocultar-tarjeta-contado/src/

# 4. Regenerar los tipos a partir del input query
cd extensions/ocultar-tarjeta-contado && shopify app function typegen && cd ../..

# 5. Deploy e instalación en martinez-motos.myshopify.com
shopify app deploy
```

## Activarla (el paso que se olvida)

Deployar **no** la enciende. Hay que crear una *payment customization* que apunte a
la función. La plantilla `payment_customization` genera una página de admin dentro
de la app justamente para eso: abrí la app en tu admin de Shopify y creá la
customization desde ahí.

No lo puedo hacer yo por API: `PaymentCustomizationInput.functionHandle` está
*"scoped to your app ID"*, así que la mutation sólo la puede ejecutar la app dueña
de la función, no el conector con el que trabajo.

## Probar

Con el theme de prueba (`?preview_theme_id=188692562107`):

1. Agregá algo al carrito y elegí **Tarjeta, débito o cuotas** → en el checkout
   tienen que aparecer los tres medios de pago, total sin descuento.
2. Volvé y elegí **Transferencia o efectivo** → el total baja 10% y en el checkout
   **debe desaparecer "Tarjeta de crédito"**, quedando sólo transferencia y efectivo.

Si el total baja pero la tarjeta sigue apareciendo, la función no está activada o
está alcanzada por las restricciones de abajo.

## Lo que hay que saber antes de invertir el tiempo

**Restricciones de plan y geográficas.** La doc de Shopify dice *"Plan and
geographical restrictions apply"* sin detallar cuáles. Si la API está restringida
para la tienda, la función corre igual pero **las operaciones de ocultar no surten
efecto**: el checkout sigue mostrando la tarjeta. Nada se rompe, simplemente no
hace nada. Esto sólo se puede comprobar deployando.

Lo que sí está confirmado en la doc: ocultar *placements* específicos es Plus, pero
en tiendas no-Plus `HideOperation` ignora el placement y **oculta el método entero**,
que es justo lo que queremos. Y las Shopify Functions están disponibles en "all
plans except Shopify Starter".

**Dónde NO corre.** En Point of Sale las payment customization functions no se
ejecutan. En Shop Pay no aplican operaciones salvo sobre el gift card nativo.

**Lista blanca, no lista negra.** Con contado elegido se deja sólo lo que matchee
`transferencia` o `efectivo` y se oculta todo lo demás. Si mañana agregás Mercado
Pago o Apple Pay, quedan ocultos solos, sin tocar la función.

**Fail-open.** Si ningún método matchea la lista blanca (los renombraste, los
desactivaste), la función no oculta nada en vez de dejar el checkout sin ninguna
forma de pagar. Hay un test para eso.
