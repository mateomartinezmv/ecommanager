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

## Publicar en Instagram y Facebook desde Claude Code

`mcp/meta/` es un conector (servidor MCP) que le permite a Claude Code publicar en la página de
Facebook y en el Instagram del negocio: fotos, carruseles, reels, historias y posteos
programados. Se registra solo con `.mcp.json`; la configuración del token está en
`mcp/meta/README.md`.

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

---

## Descatalogar productos (Stock → ⛔)

Para los productos que no se vuelven a comprar: el que ya está en cero y no se importa más,
y el que todavía tiene stock pero no se repone cuando se termine.

**Antes de usarlo hay que agregar las columnas una sola vez:**

1. Entrá a Supabase → **SQL Editor** → **New query**
2. Copiá todo el contenido de `supabase/migrations/20261008010000_add_motivo_discontinuado.sql`
3. **Run**

Si todavía no corriste la migración, el botón funciona igual (el producto queda
descatalogado) pero el motivo no se guarda, y la pestaña ⛔ te avisa qué archivo falta.

**Cómo se usa:** en Stock, el botón **⛔** de cada fila abre el formulario y pide un motivo.
Los motivos son: *poca venta*, *poco margen de ganancia*, *producto problemático*, *no se
consigue más*, *reemplazado por otro*, *no competitivo en precio* y *otro* (con aclaración).
El motivo es obligatorio: es lo único que después permite ver un patrón. Se puede agregar una
aclaración libre y cambiar la fecha.

Para corregir el motivo de uno ya descatalogado, hacé clic en su badge de la columna
**Estado**. Con **♻️** vuelve al catálogo y se le borra el motivo.

**Qué cambia cuando un producto está descatalogado:**

- Desaparece de **Reposición**: deja de pedir compra, deja de contar para el lead time y no
  entra más en el calendario de pedidos.
- Desaparece de los avisos de **stock bajo** del dashboard.
- **Las unidades que queden se siguen vendiendo igual**, y cada venta le sigue descontando el
  stock en MELI y en Shopify. Descatalogar no es pausar la publicación ni poner stock 0.
- **Mientras le queden unidades sigue entrando en la sincronización masiva** (el botón 🔄, el
  cron de publicaciones y el sync de Shopify): si se lo dejara afuera, una venta cuya
  notificación se perdió o un cambio hecho a mano en MELI lo dejarían ofreciendo mercadería
  que ya no está, que es justo lo que esa sincronización viene a evitar.
- Cuando llega a **cero** sí queda afuera de la sincronización: ya no tiene nada que ofrecer,
  y volver a escribirle 0 a una publicación que capaz cerraste a mano es tocar algo que ya no
  maneja el CRM.
- No se borra nada: el histórico de ventas y los reportes quedan intactos.

**El análisis**, en la pestaña **⛔ Discontinuados**:

- Cuántos productos se descatalogaron, cuántas unidades quedan por liquidar y cuánto costaron
  esas unidades (la plata que está parada).
- Un gráfico con el reparto por motivo: si la mitad del catálogo caído es "poca venta", el
  problema es qué se compra; si es "poco margen", es a qué precio se compra.
- **Qué estilo de producto se cae**, por grupo: cuántos productos del grupo están
  descatalogados sobre el total del grupo, con qué motivos y qué subgrupos arrastran la
  cuenta. Está ordenado por proporción y no por cantidad, porque 3 de 4 productos de un grupo
  chico dice mucho más que 5 de 60 del grupo más grande.
- Un filtro por motivo para ver sólo los de una causa.

Los productos que ya estaban descatalogados de antes aparecen como **"Sin motivo
registrado"**: se les puede poner el motivo a mano desde el badge de la columna Estado.

---

## Waitlist: avisar a un cliente cuando vuelve un producto (Clientes → 🔔 / Stock → 🔔 Waitlist)

Para el cliente que pide algo que está agotado: se lo anota con el SKU que espera y, cuando
llega la importación que lo trae, el CRM te lo marca para que le mandes el WhatsApp.

**Antes de usarla hay que crear la tabla una sola vez:**

1. Entrá a Supabase → **SQL Editor** → **New query**
2. Copiá todo el contenido de `supabase/migrations/20261029000000_add_avisos_stock.sql`
3. **Run**

Si todavía no corriste la migración, el resto del CRM funciona igual y la pestaña 🔔 te avisa
qué archivo falta.

**Anotar a un cliente:** en **Clientes**, el botón **🔔** de cada fila. Buscás el producto por
SKU o por nombre, ponés cuántas unidades quiere y una nota opcional ("lo quiere en negro").
Si el cliente no tiene teléfono te lo pide ahí mismo y lo guarda en su ficha, porque es a
donde le va a llegar el aviso. Un cliente puede esperar varios productos, pero no el mismo
dos veces mientras el aviso siga abierto. El botón muestra cuántos productos espera y se pone
azul cuando alguno ya llegó.

**Cuándo se dispara:** cuando una importación pasa a **recibida** (✅ Marcar llegada en
Importaciones), todos los clientes que esperaban alguno de sus SKUs pasan a **📲 Para
avisar**, y el aviso de llegada te dice cuántos son. Un ajuste de stock a mano, una devolución
o una venta cancelada **no** disparan nada: lo que cuenta es que entró mercadería nueva.

**Avisar:** en **Stock → 🔔 Waitlist** están todos los productos que alguien espera,
agrupados por SKU, con un filtro por SKU y otro por estado:

- **📲 Para avisar**: ya llegó su importación. El botón **📱 Avisar** abre WhatsApp con el
  mensaje armado ("Hola Juan! … Ya nos volvió a entrar …") y el aviso pasa a **✅ Avisado**.
- **⏳ Esperando**: todavía no llegó. Al lado del SKU se ve si viene en una importación en
  camino (y cuándo llega) o si no hay ninguna pedida: la tarjeta **Pedidos sin importación en
  camino** es lo que te están pidiendo y todavía no compraste.
- **✕** saca al cliente de la lista (ya no lo quiere, se lo consiguió en otro lado).

Dentro de cada SKU el que se anotó primero aparece primero, que es a quien corresponde
avisarle antes si llegan pocas unidades.

---

## Control de despacho con lector de códigos (✅ Control de despacho)

Para que lo que entra en cada paquete de MELI (Flex y Mercado Envíos) sea lo que se vendió,
sin depender de que quien arma lea bien la hoja. Se usa en la PC de la oficina con un lector
de códigos 2D (lee el código de barras de Mercado Envíos y el QR de Flex) enchufado por USB o
con su receptor inalámbrico: el lector funciona como un teclado, no hay que instalar nada.

**Antes de usarlo hay que agregar las columnas una sola vez:**

1. Entrá a Supabase → **SQL Editor** → **New query**
2. Copiá todo el contenido de `supabase/migrations/20261103000000_add_control_envios.sql`
3. **Run**

Si todavía no corriste la migración, el control funciona igual (avisa cuando algo está mal),
pero no queda anotado en Envíos y la pantalla te dice qué archivo falta.

**Cómo se usa:** las etiquetas se siguen imprimiendo desde MELI como siempre. Con la caja
abierta:

1. Se escanea la **etiqueta de MELI** del paquete. La pantalla muestra qué tiene que ir
   adentro: SKU, variante resaltada, cantidad y la foto de la publicación. Si es un carrito,
   aparecen todos sus productos.
2. Se escanea la **etiqueta del CRM** de cada producto a medida que se mete en la caja.
   - ✅ Verde y un tono corto: es el correcto.
   - ❌ Rojo y un zumbido: es otro producto, otra variante o una unidad de más. Dice qué
     sacar y qué falta.
3. Cuando está todo suena **✅ Paquete controlado**: se cierra la caja y se pasa al siguiente
   escaneando su etiqueta.

Los productos que se venden de a par piden un escaneo por cada caja. Una venta cancelada
avisa **⛔ NO se despacha**. Si una etiqueta del CRM no se puede leer, el botón **✋ No lee la
etiqueta** la da por puesta, pero queda registrado como "a mano". Si la etiqueta de MELI no
se lee, el paquete se elige de la lista **Para despachar** con **Controlar**.

**Imprimir las etiquetas desde el control:** en la lista **Para despachar**, cada envío
pendiente tiene una casilla y dice cómo está su etiqueta:

- **De MELI (🖨️):** **Impresa**, **Sin imprimir** o **No disponible** (MELI todavía no la
  entrega, por ejemplo si el pago está pendiente). Se le pregunta a MELI, así que cuenta
  también lo que se imprimió desde su panel.
- **Del CRM (🏷️), las de mostrador y Shopify de 100 × 150:** **Impresa**, **Sin imprimir** o
  **Falta dirección** (sin dirección no se puede armar: se carga con ✏️ en Envíos).

Arriba de la lista:

- **Todas** / **Las que faltan imprimir** / **Ninguna** marcan las casillas; después se puede
  sumar o sacar alguna a mano.
- **🖨️ Imprimir (N)** baja **un solo PDF** con las elegidas, las de MELI y las del CRM juntas,
  para mandarlo a la térmica desde la PC de la oficina. Al imprimirlas, MELI marca las suyas
  como impresas, igual que desde su panel; las del CRM quedan anotadas en el envío.

Para que el CRM recuerde las etiquetas propias impresas después de recargar la página, hay
que correr una vez `supabase/migrations/20261103010000_add_etiqueta_impresa.sql` (igual que
la de arriba). Sin eso se imprimen igual y la pantalla avisa qué falta.

**Lo que ves en Envíos:** arriba, cuántos de los pendientes ya pasaron por el lector y cuántos
escaneos equivocados se frenaron hoy; en cada envío, **✅ Controlado** (con las unidades
marcadas a mano y los errores frenados) o **Sin controlar**.

**Cómo encuentra el paquete:** en Mercado Envíos el número del código de barras ya está en el
tracking. En Flex no, así que el CRM guarda el número de envío de MELI cuando se sincroniza el
envío; si todavía no lo tiene, la primera vez que se escanea la etiqueta se lo pregunta a MELI
y lo guarda.

**Si el lector escribe símbolos raros** (porque está configurado con otro idioma de teclado
que la PC), no hace falta tocarlo: el CRM compara sólo letras y números. Igual conviene
configurarlo en español con los códigos del manual.

---

## Instagram y Facebook (Marketing → 📣 Redes)

> **¿Y el conector de Claude Code (`mcp/meta/`)?** Son complementarios. El conector sirve para
> que Claude Code publique *en el momento* desde tu compu. Esta pantalla y su cron viven en
> Vercel: publican *a la hora programada* aunque no haya nadie conectado, que es lo que
> necesitan las tareas programadas. Los dos usan el mismo tipo de token (el de la página), así
> que la misma app de Meta sirve para los dos.

Para programar posts, carruseles e historias de **@martinezmotos.uy** y de la **página de
Facebook** vinculada, desde el CRM. Cada publicación dice dónde sale: Instagram, Facebook o
las dos (lo que se carga sin indicar nada sale en las dos). La API de Meta no programa
publicaciones: publica en el momento. Por eso cada publicación se guarda en
Supabase con su fecha y hora, y un cron (`/api/cron/instagram-publicar`, cada 5 minutos) la
publica cuando llega la hora. Sale con hasta 5 minutos de atraso y avisa por Telegram si
salió o si falló.

**Lo que hay que hacer una sola vez:**

1. **La cuenta de Instagram** tiene que ser profesional (empresa o creador) y estar vinculada
   a una página de Facebook. Se revisa en Instagram → Configuración → Tipo de cuenta, y en
   Meta Business Suite → Configuración → Cuentas de Instagram.
2. **Crear la app en Meta:** entrá a https://developers.facebook.com/apps → **Crear app** →
   tipo **Empresa**. Agregale el producto **Inicio de sesión con Facebook para empresas**, y
   en su configuración cargá como **URI de redireccionamiento de OAuth válido**:
   `https://TU-PROYECTO.vercel.app/api/meta/callback`.
   - Mientras la app esté en **modo desarrollo** solo la pueden usar sus administradores.
     Alcanza si el que conecta sos vos, que es el administrador de la página: no hace falta
     pasar la revisión de Meta para publicar en tu propia cuenta.
3. **Variables de entorno en Vercel** (Settings → Environment Variables):

   | Variable | Valor |
   |----------|-------|
   | `META_APP_ID` | El identificador de la app (Configuración de la app → Básica) |
   | `META_APP_SECRET` | La clave secreta de la app (misma pantalla) |
   | `META_REDIRECT_URI` | `https://TU-PROYECTO.vercel.app/api/meta/callback` |
   | `META_IG_USERNAME` | `martinezmotos.uy` (opcional: si tu Facebook administra varias páginas con Instagram, elige esta) |

   Después, **Deployments → Redeploy** para que las tome.
4. **Crear las tablas en Supabase:** SQL Editor → New query → pegá
   `supabase/migrations/20261105010000_add_instagram.sql` → **Run**, y después
   `supabase/migrations/20261106000000_add_facebook_publicaciones.sql` → **Run**.
5. **Conectar:** en el CRM, **📣 Redes** → **🔗 Conectar Meta**, iniciá sesión con el
   Facebook que administra la página y aceptá los permisos (entre ellos, publicar en la
   página). Volvés al CRM con "✅ Instagram y Facebook conectados correctamente" y la cuenta
   arriba.

El token que se guarda es el de la página y no vence: solo hay que reconectar si cambiás la
contraseña de Facebook o le quitás los permisos a la app.

**Cómo se usa:** en el formulario elegís el tipo, dónde sale (Instagram, Facebook o las dos),
pegás las URLs de las imágenes (una por línea, en el orden en que salen), el texto y la fecha
y hora. La tabla de abajo muestra lo programado, lo publicado (con el link en cada red) y lo
que falló con el motivo; lo que todavía no salió se puede **🚀 Publicar ya** o **✖ Cancelar**,
y lo que falló, **🔁 Reintentar**. Si salió en una red y falló en la otra, el reintento publica
solo en la que faltaba.

En Facebook, un carrusel sale como un único posteo con todas las fotos, y una historia sale
como historia de la página.

**Límites de Meta:**

- Las imágenes tienen que ser **JPEG** y estar en una **URL pública**: Meta las descarga desde
  su lado. No acepta PNG.
- Un carrusel lleva de 2 a 10 imágenes. El texto, hasta 2.200 caracteres y 30 hashtags.
- Las **historias** van sin texto y sin stickers (tampoco el de enlace): la API no los permite,
  ni en Instagram ni en Facebook. Una historia con link hay que subirla desde la app.

También se pueden programar publicaciones sin la pantalla, insertando filas en la tabla
`instagram_publicaciones` (`tipo`, `imagenes`, `caption`, `programado_para` y, si no va en
las dos redes, `redes`): el cron las publica igual.

## Fotos de producto con IA (Marketing → 📸 Fotos)

Genera con Higgsfield las fotos de una publicación —portada, medidas, compatibilidad,
beneficios e instalación— con el logo de la tienda, y las sube directo a MELI. Se elige el
producto (grupo + subgrupo) y cuáles de sus variantes (cada SKU, por ejemplo cada color).

**Cómo funciona:**

1. **Preparar textos** (no gasta nada): lee las fotos y la ficha de cada variante en MELI y
   la IA de texto propone lo que va escrito dentro de cada imagen. **Revisalo**: las medidas
   y la compatibilidad salen tal cual en la foto, y un dato mal puesto se paga en devoluciones.
2. **Generar**: cada imagen se pide a Higgsfield usando como referencia las fotos de MELI de
   esa variante, así copia el producto real en su color. La de instalación se genera una sola
   vez y se usa en todas las variantes. Tardan alrededor de un minuto cada una y van de a 4;
   la pantalla las sigue sola mientras esté abierta (si la cerrás, sigue cuando volvés).
3. Al terminar, el CRM le pega el logo (`public/marca/`) arriba a la derecha —la versión con
   letras negras sobre fondo claro, la original sobre fondo oscuro— y la guarda en Supabase
   Storage. **La portada va sin logo**: MELI pide la foto principal limpia.
4. **Publicar en MELI**: reemplaza las fotos de todas las publicaciones de esa variante (la
   original y los ángulos), con la portada primero. Tildando "dejar también las fotos
   actuales", las nuevas van adelante y las de antes quedan después. Las publicaciones de
   catálogo y las que tienen variaciones clásicas se saltean (se avisa cuáles).

Cada foto se puede descargar, regenerar o descartar antes de publicar.

**Lo que hay que hacer una sola vez:**

1. **API key de Higgsfield:** entrá a https://console.higgsfield.ai → API Keys → crear. Es la
   API de pago por uso, **aparte de los créditos de la app de Higgsfield**: hay que cargarle
   saldo en la consola.
2. **Variable de entorno en Vercel:** `HIGGSFIELD_API_KEY` = `ID:SECRET` (los dos valores que
   da la consola, separados por dos puntos). Después, **Redeploy**. La redacción de los textos
   usa la `ANTHROPIC_API_KEY` que ya está; sin ella, los textos se completan a mano.
3. **Crear la tabla y el bucket en Supabase:** SQL Editor → pegá
   `supabase/migrations/20261107000000_add_fotos_ia.sql` → **Run**.

El modelo es `marketing-studio/image/sunburst` (GPT Image de Higgsfield Marketing Studio): es
el que copia bien el producto de una foto y escribe en español sin errores. Para cambiar el
logo, reemplazá los dos PNG de `public/marca/`.
