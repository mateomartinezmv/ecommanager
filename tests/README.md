# Tests

```bash
npm install     # una sola vez
npm test
```

Playwright trae su propio Chromium. Si es la primera vez en esa máquina:

```bash
npx playwright install chromium
```

## Cómo están armados

El CRM entero es un solo `public/index.html` con el HTML, el CSS y ~8.000 líneas de JS en un
`<script>` inline. No hay módulos que importar ni funciones exportadas, así que la única
forma de verificar la lógica de negocio *del front* —qué entra en la ganancia neta, qué
computa contra el tope del Literal E, qué se guarda al cargar un gasto en dólares— es abrir
la página de verdad en un navegador y manejarla como la maneja el usuario.

`helpers.js` levanta un servidor estático sobre `public/` (Playwright sólo puede interceptar
pedidos `http`, no `file://`), abre Chromium e intercepta `/api/**` contra un estado en memoria
que imita a Supabase. Los tests leen ese estado para comprobar qué se guardó realmente, no sólo
lo que se ve en pantalla.

Cada suite exige además que no hayan quedado errores de consola ni `alert()` inesperados; el
ruido de los CDN que no cargan sin red se filtra en `erroresReales()`.

Lo que sí vive en un módulo de `api/` se testea directo, sin navegador: es el caso de
`descatalogado-reglas.test.js`.

| Archivo | Qué cubre |
|---|---|
| `finanzas.test.js` | Gastos e ingresos extra: totales por período, gráficos circulares por categoría, filtros, conversión USD→UYU con la cotización del día, el check del Literal E, el recálculo de la ganancia neta en Reportes, el ABM de categorías y la exportación a PDF. |
| `sin-migracion.test.js` | El estado en el que una migración todavía no se corrió en Supabase (la tabla `movimientos`, las columnas del motivo de descatalogado): el resto del CRM tiene que funcionar igual y la pantalla nueva tiene que explicar qué falta. |
| `descatalogado-reglas.test.js` | Las reglas que no pasan por la pantalla, directo sobre `api/_discontinuado.js` (sin navegador): qué columnas se escriben al descatalogar, reactivar y editar, y qué productos entran en la sincronización de stock. |
| `descatalogar.test.js` | Descatalogar productos: el motivo obligatorio y lo que queda guardado, que el producto salga de la lista y de los avisos de stock bajo, el filtro y el análisis de la pestaña ⛔, que editar el producto no lo reactive y que reactivar limpie el motivo. |
| `etiqueta-envio.test.js` | La etiqueta de envío 100 × 150 mm de las ventas de mostrador (🏷️): nombre, teléfono sacado de la ficha del cliente (por la venta o por el nombre), dirección y contenido de un carrito; que una venta sin envío pida la dirección y la etiqueta salga al guardarlo; y que las ventas de MELI no tengan el botón. |
| `ads-economia.test.js` | La cuenta del margen y el ROAS de equilibrio, directo sobre `api/meli/_economia.js` (sin navegador): la comisión que sale de lo que MELI cobró, el envío prorrateado entre las ventas de un mismo paquete, los envíos sin costo cargado y la cadena de respaldo cuando un SKU no tiene historia propia. Y el reparto de un anuncio entre las variantes que lo comparten (`sumarGrupos` de `ads-recomendaciones.js`), que es lo que evita contar el mismo gasto una vez por color. |
| `ads.test.js` | La pestaña 📣 Ads: que la pantalla no imponga un 15% de comisión, el ROAS de equilibrio de la campaña y su tarjeta, el aviso de los envíos sin costo y el tooltip con la cuenta entera. Y la sección 🎯 Qué anunciar y qué apagar: productos sin campaña, el histórico que frena volver a prender lo que ya perdía, los chips por familia y por motivo, esconder los que vienen pagando, lo que queda afuera y por qué, el aviso de la migración del snapshot, la campaña que no se pudo leer entera y el caso sin perfil de anunciante. Con dos campañas corriendo: la opción de mirarlas juntas, el desglose por campaña, de qué campaña es cada anuncio, y el producto que quedó en las dos. |
| `fotos-angulos.test.js` | La comparación de las fotos de cada publicación contra las de su original, directo sobre `api/meli/_fotos.js` (sin navegador): que el orden cuente, que la misma imagen con otro id no figure como distinta, qué publicación se puede corregir y cuál no (catálogo, cerradas), y el cuerpo del PUT que se le manda a MELI. |
| `fotos-pantalla.test.js` | La pestaña 🖼️ Fotos por publicación: las fotos de cada ángulo en orden al lado de las de la original, el botón de copiar sólo donde hay algo que corregir, el motivo a la vista en lo que MELI no deja tocar, y que después de copiar la pantalla vuelva a leer el estado. |

## Al agregar tests

Los subtests de un archivo comparten la página y corren en orden: los de `finanzas.test.js`
cargan movimientos y después verifican cómo cambian los totales, y los de
`descatalogar.test.js` descatalogan productos y después miran el análisis que sale de eso. Si
un test nuevo no depende de ese estado, conviene abrir su propio `abrirCRM()` en otro
archivo.
| `ads-margen.test.js` | La sección 💰 Productos por margen de la pestaña de Ads: margen = precio − costo, cada producto en su segmento (alto, medio, bajo, sin margen, sin datos), los cortes editables en % y en $, el filtro de stock, que los descatalogados no entren y la marca de los que ya tienen anuncio. El reparto del presupuesto entre las campañas por segmento (margen × ventas MELI de 30 días, con tope en lo que el margen paga y el sobrante avisado) y las recomendaciones de subir, bajar o arrancar según el gasto actual y si viene ganando. También la tabla de campañas (el ROAS objetivo cargado en MELI contra el equilibrio), el margen real con comisión y envío, el ROAS objetivo por segmento, los productos en la campaña de otro segmento, aplicar el reparto y pausar un anuncio (qué se manda a MELI), las ventas orgánicas y el TACOS, la evolución semanal por segmento y el registro de cambios con su antes y después. |
| `proveedores-reglas.test.js` | Directo sobre `api/_proveedores.js` y `api/importaciones.js` con un Supabase falso (sin navegador): el mínimo de compra por defecto (USD 300), a qué proveedor queda cada producto (el de su importación más reciente, sin canceladas ni las cargadas sin proveedor), que ponerle proveedor a una importación vieja no vuelva a sumar stock, que editar sólo las notas no pise una asignación hecha a mano, y la importación que se guarda igual cuando la columna todavía no existe. |
| `proveedores-pantalla.test.js` | Importaciones → 🏭 Proveedores y 🛒 Compras por proveedor (`importaciones.html`, con su propio mock): la importación nueva que exige proveedor y el alta de uno desde el selector, el proveedor de una importación vieja elegido desde la tabla, la ficha con datos y números, asignar a mano los productos sin proveedor, la compra recomendada completada hasta el mínimo y convertida en importación, el estado sin la migración, y el aviso de 📅 Reposición que separa el hueco sin stock de lo que hay que volver a pedir. |
| `ads-acciones.test.js` | Directo sobre `api/meli/` (sin navegador): la conversión de ROAS objetivo a ACOS objetivo que se manda a MELI y los valores que no se dejan pasar, el antes y después de un cambio (ventanas de 14 días comparadas por día, el cambio reciente que todavía no se juzga, el cambio de un solo anuncio) y la semana de cada día en la evolución. |
