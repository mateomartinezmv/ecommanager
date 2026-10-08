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

## Al agregar tests

Los subtests de un archivo comparten la página y corren en orden: los de `finanzas.test.js`
cargan movimientos y después verifican cómo cambian los totales, y los de
`descatalogar.test.js` descatalogan productos y después miran el análisis que sale de eso. Si
un test nuevo no depende de ese estado, conviene abrir su propio `abrirCRM()` en otro
archivo.
