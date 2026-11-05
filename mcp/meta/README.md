# Conector de Meta (Facebook + Instagram) para Claude Code

Un servidor MCP que le da a Claude Code herramientas para publicar en la página de Facebook y en
el Instagram del negocio. Le decís a Claude "subí esta foto a Instagram y Facebook con este
texto" y lo hace, sin abrir Meta Business Suite.

Business Suite no tiene una API propia: por atrás usa **Graph API** con el token de la página. El
Instagram profesional cuelga de esa página, así que con un solo token se publica en los dos lados.

## Qué puede hacer

| Herramienta | Qué hace |
|---|---|
| `meta_cuentas` | Muestra la página y el Instagram conectados, y cuántas publicaciones por API quedan hoy en Instagram. Sirve para probar la conexión. |
| `facebook_publicar` | Texto, texto + link, 1 foto, varias fotos en un posteo, o un video. Se puede **programar** (`programar: "2026-11-06T10:00:00-03:00"`). |
| `instagram_publicar` | Foto, carrusel (2 a 10 fotos/videos), reel o historia. |
| `instagram_estado` | Termina de publicar un reel que quedó procesando. |
| `meta_recientes` | Lista los últimos posteos de cada red, con su link. |

Las fotos y videos pueden ser **URLs públicas o archivos de la compu**. Instagram sólo acepta
URLs, así que los archivos locales se suben antes a un bucket público de Supabase Storage
(`redes`, se crea solo) y se le pasa esa URL a Meta.

Claude Code te pide permiso antes de cada publicación, así que nada sale sin que lo veas.

## Configuración (una sola vez, ~15 minutos)

### 1. Instagram vinculado a la página

El Instagram tiene que ser una cuenta **profesional** (empresa o creador) y estar vinculado a la
página de Facebook: Meta Business Suite → Configuración → Cuentas → Cuentas de Instagram.

### 2. Crear una app de Meta

1. Entrá a https://developers.facebook.com/apps y hacé clic en **Crear app**.
2. Caso de uso: **Otro** → tipo **Negocio**. Ponele un nombre (ej. `EcomManager Redes`) y asociala
   a tu portfolio comercial.
3. En **Configuración de la app → Básica** copiá el **Identificador de la app** y la **Clave secreta**.

La app puede quedar en **modo desarrollo**: como sos administrador de la app y de la página, no
hace falta pasar por la revisión de Meta para publicar en tus propias cuentas.

### 3. Sacar el token

1. Abrí el [Explorador de Graph API](https://developers.facebook.com/tools/explorer/) y elegí tu app arriba a la derecha.
2. En **Permisos** agregá:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
   `instagram_content_publish`, `business_management`.
3. Hacé clic en **Generate Access Token**, aceptá y elegí la página y el Instagram.
4. Copiá el token (dura una hora) y corré, desde la raíz del repo:

```bash
META_APP_ID=tu_app_id META_APP_SECRET=tu_clave_secreta node mcp/meta/obtener-token.js EL_TOKEN_COPIADO --guardar
```

Eso lo cambia por un **token de página que no vence** y lo guarda en `mcp/meta/.env` (que no se
sube a GitHub) junto con los ids de la página y del Instagram. Si administrás varias páginas, te
las lista y lo volvés a correr con `--pagina <id>`.

> Alternativa más prolija para el negocio: un **usuario del sistema** en Configuración del negocio
> → Usuarios → Usuarios del sistema, con un token generado ahí. No depende de tu cuenta personal.
> Ese token va en `META_PAGE_ACCESS_TOKEN` igual.

### 4. Supabase (para publicar archivos de la compu)

Agregá al mismo `mcp/meta/.env`:

```
SUPABASE_URL=https://ulhziakmuwjdkbypwxpz.supabase.co
SUPABASE_SERVICE_KEY=tu_service_role_key
```

Si sólo vas a publicar con URLs (por ejemplo, fotos de MELI o de Shopify), no hace falta.

### 5. Abrir Claude Code

Abrí Claude Code **en la raíz del repo**. La primera vez te pregunta si confiás en el servidor
`meta` de `.mcp.json`: decile que sí. Con `/mcp` ves si está conectado. Probá pidiéndole
"mostrame las cuentas de Meta conectadas".

## Variables

| Variable | Obligatoria | Qué es |
|---|---|---|
| `META_PAGE_ACCESS_TOKEN` | Sí | Token de la página (paso 3). |
| `META_PAGE_ID` | No | Id de la página. Si falta, sale del token. |
| `META_IG_USER_ID` | No | Id del Instagram profesional. Si falta, se busca en la página. |
| `META_GRAPH_VERSION` | No | Versión de Graph API (default `v24.0`). |
| `META_BUCKET` | No | Bucket de Supabase para archivos locales (default `redes`). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Para archivos locales | Las mismas del resto de EcomManager. |

Se leen del entorno o de `mcp/meta/.env`.

## Usarlo desde Claude Code en la nube

En una sesión en la nube no hay `.env`: cargá las variables en la configuración del entorno, y en
**Acceso a la red** agregá `graph.facebook.com` y tu dominio de Supabase a los dominios permitidos.
Sin eso, el contenedor no llega a Meta.

## Límites de Meta

- Instagram: hasta **100 publicaciones por API cada 24 h**; texto de hasta 2200 caracteres, 30
  hashtags y 20 menciones; las fotos tienen que ser **JPG**. No deja programar por API.
- Facebook: programar entre 10 minutos y 75 días en el futuro. No se combinan link y fotos en el
  mismo posteo.
- Supabase (plan gratis): archivos de hasta 50 MB. Para reels más pesados, pasá una URL.

## Archivos

- `server.js`: el servidor MCP (lo arranca Claude Code con `.mcp.json`).
- `_meta.js`: la lógica de Graph API, probada en `tests/meta-publicar.test.js`.
- `_subir.js`: sube archivos locales a Supabase Storage.
- `obtener-token.js`: cambia el token corto por uno de página que no vence.
