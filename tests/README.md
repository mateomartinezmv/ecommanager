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
`<script>` inline. No hay módulos que importar ni funciones exportadas, así que la única forma
de verificar la lógica de negocio —qué entra en la ganancia neta, qué computa contra el tope
del Literal E, qué se guarda al cargar un gasto en dólares— es abrir la página de verdad en un
navegador y manejarla como la maneja el usuario.

`helpers.js` levanta un servidor estático sobre `public/` (Playwright sólo puede interceptar
pedidos `http`, no `file://`), abre Chromium e intercepta `/api/**` contra un estado en memoria
que imita a Supabase. Los tests leen ese estado para comprobar qué se guardó realmente, no sólo
lo que se ve en pantalla.

Cada suite exige además que no hayan quedado errores de consola ni `alert()` inesperados; el
ruido de los CDN que no cargan sin red se filtra en `erroresReales()`.

| Archivo | Qué cubre |
|---|---|
| `finanzas.test.js` | Gastos e ingresos extra: totales por período, gráficos circulares por categoría, filtros, conversión USD→UYU con la cotización del día, el check del Literal E, el recálculo de la ganancia neta en Reportes, el ABM de categorías y la exportación a PDF. |
| `sin-migracion.test.js` | El estado en el que la migración de `movimientos` todavía no se corrió en Supabase: el resto del CRM tiene que funcionar igual y la pantalla nueva tiene que explicar qué falta. |

## Al agregar tests

Los subtests de un archivo comparten la página y corren en orden: los de `finanzas.test.js`
cargan movimientos y después verifican cómo cambian los totales. Si un test nuevo no depende
de ese estado, conviene abrir su propio `abrirCRM()` en otro archivo.
