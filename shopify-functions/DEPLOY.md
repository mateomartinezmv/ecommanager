# Deploy paso a paso (Windows)

Para subir la función que oculta la tarjeta cuando el cliente elige contado.
Cada paso dice qué tenés que ver si salió bien. Si algo no coincide, pará ahí.

---

## Qué es el CLI, en una línea

Un programa que se usa **escribiendo comandos** en una ventana negra en vez de
haciendo clics. Las Shopify Functions no se pueden subir desde el navegador: hay
que compilarlas en tu PC y mandarlas, y eso lo hace el CLI.

**Abrir la terminal en Windows:** tecla Windows → escribí `powershell` → Enter.
Se abre una ventana azul. Ahí va todo lo que sigue, un comando por vez, Enter
después de cada uno.

> Ojo: el Dev Dashboard donde estabas (la sección **Catálogos**) no tiene nada que
> ver con esto. No hace falta que crees la app a mano ahí: el CLI te la crea sola.

---

## Paso 1 — Node.js

Es lo que hace funcionar al CLI.

1. Entrá a **https://nodejs.org** y bajá el instalador **LTS** para Windows.
2. Instalalo con "Siguiente" en todo.
3. **Cerrá PowerShell y abrilo de nuevo** (si no, no toma el cambio).
4. Verificá:

```powershell
node -v
```

**Tiene que decir `v22.12.0` o más alto.** Si dice algo menor (ej. `v18`), instalá
de nuevo desde nodejs.org. Si dice "no se reconoce", Node no quedó instalado.

---

## Paso 2 — Git

```powershell
git --version
```

Si dice "no se reconoce", bajalo de **https://git-scm.com/download/win**, instalalo
con las opciones por defecto, cerrá y reabrí PowerShell, y probá de nuevo.
Tiene que decir **2.28.0 o más alto**.

---

## Paso 3 — Shopify CLI

```powershell
npm install -g @shopify/cli@latest
```

Tarda un par de minutos y escupe mucho texto. Verificá:

```powershell
shopify version
```

Tiene que devolver un número de versión.

---

## Paso 4 — Crear la app

```powershell
cd $HOME\Documents
shopify app init
```

Te va a ir preguntando:

| Pregunta | Qué elegir |
|---|---|
| Login | Se abre el navegador. Entrá con tu cuenta de Partner. |
| Template | **Build a React Router app** |
| Organización | La que tiene Martinez Motos |
| ¿Crear como app nueva? | **Yes, create it as a new app** |
| Nombre | `martinez-motos-pagos` |

Al terminar creó una carpeta `martinez-motos-pagos` en Documentos.

---

## Paso 5 — Generar la extensión

```powershell
cd martinez-motos-pagos
shopify app generate extension --template payment_customization --name ocultar-tarjeta-contado
```

Cuando pregunte el lenguaje, elegí **JavaScript** (la opción 2). No elijas Rust:
necesita instalar compiladores de C++ aparte.

---

## Si el paso 5 falla con `pnpm` no se reconoce

```
Error coming from 'pnpm install'
"pnpm" no se reconoce como un comando interno o externo
```

El CLI eligió **pnpm** como gestor de paquetes y no lo tenés instalado. La
extensión ya quedó generada; lo único que falló fue bajar las dependencias.

```powershell
npm install -g pnpm
pnpm --version
```

Después, parado en la carpeta de la app:

```powershell
cd $HOME\Documents\martinez-motos-pagos
pnpm install
```

Verificá que la extensión esté:

```powershell
dir extensions\ocultar-tarjeta-contado\src
```

Si lista los archivos `cart_payment_methods_transform_run.*`, seguí al paso 6 sin
volver a generar nada. Si la carpeta no existe, recién ahí repetí el paso 5.

---

## Paso 6 — Reemplazar los dos archivos

Se generó la carpeta:

```
martinez-motos-pagos\extensions\ocultar-tarjeta-contado\src\
```

Hay que **reemplazar el contenido** de estos dos archivos por el de este repo:

| Archivo a reemplazar | Copiar de |
|---|---|
| `cart_payment_methods_transform_run.graphql` | `shopify-functions/src/cart_payment_methods_transform_run.graphql` |
| `cart_payment_methods_transform_run.js` | `shopify-functions/src/cart_payment_methods_transform_run.js` |

Abrilos con el Bloc de notas, borrá todo, pegá el contenido nuevo, guardá.
Los podés copiar desde GitHub, rama `claude/beautiful-planck-vttuzt`, carpeta
`shopify-functions/src/`.

---

## Paso 7 — Revisar la versión de API

Abrí `extensions\ocultar-tarjeta-contado\shopify.extension.toml` con el Bloc de
notas. Arriba de todo dice algo como:

```toml
api_version = "2025-10"
```

**Tiene que ser 2025-07 o más alto.** Si es menor, cambiá el número a `2025-10`
y guardá.

---

## Paso 8 — Regenerar los tipos

```powershell
cd extensions\ocultar-tarjeta-contado
shopify app function typegen
cd ..\..
```

Esto lee el archivo `.graphql` y genera los tipos. Si tira error acá, es que el
`.graphql` del paso 6 quedó mal pegado.

---

## Paso 9 — Deploy

```powershell
shopify app deploy
```

Te pide confirmar. Al terminar dice que la versión se publicó.

---

## Paso 10 — Instalar la app en la tienda

`shopify app dev --store=...` **no sirve**: solo funciona con tiendas de
desarrollo, y Martinez Motos es una tienda real. Falla con:

```
Could not find store for domain martinez-motos.myshopify.com in organization Martinez Motos.
```

La doc manda a la tarjeta "Distribution" del Dev Dashboard, pero en la interfaz
nueva esa tarjeta no existe. El camino que funciona:

1. Abrir la app en el Dev Dashboard, **Panel general**.
2. Bajar hasta la tarjeta **Instalaciones** → botón **Instalar app**.
3. Aunque el texto diga "tienda en desarrollo", el selector igual ofrece la
   tienda real de la organización. Elegirla e instalar, aceptando los permisos.

---

## Paso 11 — Activarla

Deployar no la enciende: hay que crear una *payment customization* que apunte a
la función.

`shopify app graphiql --store=...` tampoco sirve, por lo mismo que `app dev`: el
CLI no ve la tienda. Y `shopify app execute` limita las mutations a dev stores.

La salida es el **client credentials grant**, el mismo que usa `_shopifyToken.js`
del CRM: la app ya esta instalada en la tienda, asi que puede pedir un token con
sus propias credenciales sin intervencion del comerciante. Token valido 24 horas.

El Client ID y el Secret estan en el Dev Dashboard → Configuracion de la app →
Credenciales.

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$shop = "martinez-motos.myshopify.com"
$clientId = "PEGAR_EL_CLIENT_ID"

$secure = Read-Host "Pega el Secreto del cliente y Enter" -AsSecureString
$bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)

$tok = Invoke-RestMethod -Method Post -Uri "https://$shop/admin/oauth/access_token" -Body @{ grant_type="client_credentials"; client_id=$clientId; client_secret=$secret }
$token = $tok.access_token
"Token OK, vence en $($tok.expires_in) segundos."
```

> El `Read-Host -AsSecureString` evita que el secreto quede escrito en pantalla o
> en el historial de PowerShell. Vive solo en la memoria de esa ventana.

```powershell
$mutation = @'
mutation {
  paymentCustomizationCreate(paymentCustomization: {functionHandle: "ocultar-tarjeta-contado", title: "Ocultar tarjeta con precio contado", enabled: true}) {
    paymentCustomization { id title enabled }
    userErrors { field message }
  }
}
'@

$body = @{ query = $mutation } | ConvertTo-Json -Compress
$resp = Invoke-RestMethod -Method Post -Uri "https://$shop/admin/api/2025-10/graphql.json" -Headers @{ "X-Shopify-Access-Token" = $token } -ContentType "application/json" -Body $body
$resp | ConvertTo-Json -Depth 10
```

Respuesta esperada: un `id`, `enabled: true` y `userErrors` vacio.

**Activada el 1/10/2026:** `gid://shopify/PaymentCustomization/131104955`

Para desactivarla sin desinstalar nada, misma receta con
`paymentCustomizationUpdate` y `enabled: false`.

---

## Paso 12 — Probar

Con el theme de prueba: `https://martinezmotos.com/cart?preview_theme_id=188692562107`

1. Agregá algo al carrito, elegí **Tarjeta, débito o cuotas**, andá al checkout.
   → Tienen que verse los tres medios de pago, total sin descuento.
2. Volvé al carrito, elegí **Transferencia o efectivo**, andá al checkout.
   → El total baja 10% y **"Tarjeta de crédito" tiene que desaparecer**.

Si el total baja pero la tarjeta sigue ahí: o no quedó activada (paso 11), o te
alcanzan las restricciones de plan/geográficas que están explicadas en el README.

---

## Si se complica

Esto son 12 pasos y al final hay un riesgo que no depende de vos (las restricciones
geográficas sin documentar). Si en algún punto se te hace cuesta arriba, hay apps
del App Store que hacen lo mismo con unos clics y una cuota mensual. Decime y te
busco cuáles sirven de verdad en Basic, en vez de que pelees con el CLI.
