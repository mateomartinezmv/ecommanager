# EcomManager — Guía de Deploy

## Paso 1: Crear la base de datos en Supabase

1. Entrá a https://supabase.com y abrí tu proyecto `ecommanager`
2. En el menú izquierdo hacé clic en **SQL Editor**
3. Hacé clic en **New query**
4. Copiá TODO el contenido del archivo `supabase-schema.sql` y pegalo ahí
5. Hacé clic en **Run** (o Ctrl+Enter)
6. Deberías ver "Success. No rows returned" — eso está perfecto

---

## Paso 2: Subir el proyecto a GitHub

1. Entrá a https://github.com y hacé clic en **New repository**
2. Nombre: `ecommanager`
3. Dejalo en **Private**, hacé clic en **Create repository**
4. GitHub te va a mostrar una pantalla con instrucciones. Buscá la sección que dice **"upload an existing file"** y hacé clic ahí
5. Arrastrá TODOS los archivos y carpetas de esta carpeta
6. Hacé clic en **Commit changes**

---

## Paso 3: Deploy en Vercel

1. Entrá a https://vercel.com
2. Hacé clic en **Add New → Project**
3. Buscá y seleccioná el repositorio `ecommanager`
4. Hacé clic en **Deploy** (sin cambiar nada por ahora)
5. Vercel va a intentar deployar y va a fallar — eso es normal porque falta configurar las variables de entorno

---

## Paso 4: Configurar variables de entorno en Vercel

1. Una vez creado el proyecto, andá a **Settings → Environment Variables**
2. Agregá estas variables una por una:

| Variable | Valor |
|----------|-------|
| `MELI_CLIENT_ID` | 5130572653999156 |
| `MELI_CLIENT_SECRET` | *(tu secret key de MELI)* |
| `MELI_REDIRECT_URI` | https://TU-PROYECTO.vercel.app/api/meli/callback |
| `SUPABASE_URL` | https://ulhziakmuwjdkbypwxpz.supabase.co |
| `SUPABASE_ANON_KEY` | *(tu anon key)* |
| `SUPABASE_SERVICE_KEY` | *(tu service role key)* |

> ⚠️ Reemplazá `TU-PROYECTO` por el nombre real que te dio Vercel (ej: `ecommanager-abc123`)

3. Una vez cargadas todas, andá a **Deployments → Redeploy** para que tome las variables

---

## Paso 5: Actualizar la URL de callback en MELI

1. Entrá a https://developers.mercadolibre.com.ar
2. Abrí tu app `EcomManager`
3. Actualizá el **Redirect URI** con tu URL real: `https://TU-PROYECTO.vercel.app/api/meli/callback`
4. En **Notification URL** poné: `https://TU-PROYECTO.vercel.app/api/meli/notify`
5. Guardá

---

## Paso 6: Conectar MELI

1. Abrí tu app en `https://TU-PROYECTO.vercel.app`
2. Hacé clic en el botón amarillo **🔗 Conectar MELI**
3. Se va a abrir el login de Mercado Libre — autorizá la app
4. Vas a volver a tu app con un banner verde: "✅ Mercado Libre conectado correctamente"

---

## ¡Listo! ¿Cómo funciona ahora?

- **Cada vez que registrás una venta MELI** → el stock se descuenta automáticamente en MELI y en Supabase
- **Cada vez que MELI registra una venta** (alguien compra desde MELI directamente) → llega una notificación a `/api/meli/notify`, se registra la venta y se descuenta el stock
- **Ajuste de stock manual** → si tiene ID de publicación MELI, también se actualiza en MELI
- **Tus datos están en Supabase** → podés acceder desde cualquier PC o celular

---

## Regenerar credenciales (recomendado)

Como las credenciales fueron compartidas por chat, conviene regenerarlas:

- **MELI Secret Key**: en developers.mercadolibre.com.ar → tu app → Regenerar secret
- **Supabase Service Key**: en Supabase → Settings → API → Reset keys

Después actualizalas en Vercel → Settings → Environment Variables

---

## Tests

```bash
npm install
npm test
```

Abren el CRM en un Chromium con la API mockeada y lo manejan como lo maneja el usuario, que es
la única forma de verificar la lógica: el SPA es un solo `public/index.html` sin módulos que
importar. Detalle en `tests/README.md`.

---

## Gastos e ingresos extra (sección Finanzas)

Para registrar lo que no entra por una venta: el packaging, el envío que pagás por un cambio
o una devolución, los rendimientos de la cuenta de Mercado Pago, un reintegro de MELI.

**Antes de usarla hay que crear las tablas una sola vez:**

1. Entrá a Supabase → **SQL Editor** → **New query**
2. Copiá todo el contenido de `supabase/migrations/20261008000000_add_movimientos.sql`
3. **Run**

Después de eso, en el menú lateral aparece **Finanzas → 💵 Gastos e ingresos**:

- Cargás cada movimiento con fecha, categoría, concepto y monto (en UYU o en USD).
- Las categorías las manejás vos con el botón **🏷️ Categorías**: podés agregar las que
  quieras ("Envíos", "Packaging", "Comisiones bancarias"...) y elegirles el color con el que
  aparecen en los gráficos. Vienen nueve cargadas de arranque.
- Dos gráficos circulares muestran cómo se reparten los gastos y los ingresos del período.

**Dónde impacta:**

- En **Reportes** aparecen dos tarjetas nuevas (*Otros gastos* y *Otros ingresos*) y la
  **ganancia neta** ya los incluye: `ventas − comisiones − costo productos − envíos −
  costos fijos − otros gastos + otros ingresos`. El desglose de "Ganancia neta real (con ads)"
  también los lista, y salen en el PDF.
- El **margen %** se sigue midiendo contra los ingresos por ventas, para que no lo infle plata
  que no viene de vender.
- Un ingreso sólo suma al **tope del Literal E** si lo marcás con el check 🧾 del formulario.
  Viene apagado: los rendimientos de Mercado Pago no son facturación por venta de bienes.

> Los **costos fijos mensuales** (Vercel, BPS, IVA mínimo...) siguen cargándose en
> *Información del negocio*: son una cuota mensual que se prorratea por período, no un
> movimiento con fecha propia.
