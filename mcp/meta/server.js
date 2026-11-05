#!/usr/bin/env node
// mcp/meta/server.js
// Servidor MCP (stdio) que le da a Claude Code herramientas para publicar en la página de
// Facebook y en el Instagram del negocio. Lo registra .mcp.json en la raíz del repo.
//
// Las credenciales salen del entorno o de mcp/meta/.env (que no se commitea). Si faltan, el
// servidor arranca igual y cada herramienta explica qué falta, en vez de desaparecer.

const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const meta = require('./_meta');
const { subirArchivoPublico } = require('./_subir');

const ARCHIVO_ENV = path.join(__dirname, '.env');
if (fs.existsSync(ARCHIVO_ENV)) process.loadEnvFile(ARCHIVO_ENV);

const cfg = meta.configDesdeEnv();

function deps() {
  const cliente = meta.crearCliente({ version: cfg.version, token: cfg.pageToken });
  return {
    cliente,
    cfg,
    esperar: ms => new Promise(r => setTimeout(r, ms)),
    resolver: async ruta => {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        throw new meta.ErrorMeta('Para publicar un archivo local hace falta SUPABASE_URL y SUPABASE_SERVICE_KEY '
          + '(se sube a Supabase Storage para que Meta lo pueda bajar). O pasá una URL pública.');
      }
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      return subirArchivoPublico(ruta, { supabase, bucket: process.env.META_BUCKET || 'redes' });
    },
  };
}

function herramienta(fn) {
  return async args => {
    try {
      const r = await fn(args || {}, deps());
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      const extra = e.contenedor ? ` (contenedor: ${e.contenedor})` : '';
      return { isError: true, content: [{ type: 'text', text: `${e.message}${extra}` }] };
    }
  };
}

const medios = z.array(z.string().min(1))
  .describe('URLs públicas o rutas de archivos locales (jpg/png/webp/mp4/mov). Los locales se suben a Supabase Storage.');

const server = new McpServer({ name: 'meta', version: '1.0.0' });

server.registerTool('meta_cuentas', {
  title: 'Ver cuentas de Meta conectadas',
  description: 'Muestra la página de Facebook y la cuenta de Instagram a las que apunta el token, y cuántas '
    + 'publicaciones por API quedan en Instagram en las últimas 24 h. Sirve para chequear que la conexión anda.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, herramienta((_, d) => meta.cuentas(d)));

server.registerTool('facebook_publicar', {
  title: 'Publicar en Facebook',
  description: 'Publica (o programa) un posteo en la página de Facebook: texto, texto con link, una o varias '
    + 'fotos, o un video. Publica de verdad: confirmá el texto y las imágenes con el usuario antes.',
  inputSchema: {
    mensaje: z.string().optional().describe('Texto del posteo.'),
    link: z.string().url().optional().describe('Link para compartir (no se puede combinar con fotos).'),
    medios: medios.optional(),
    programar: z.string().optional()
      .describe('Fecha ISO con zona horaria para programarlo, ej. 2026-11-06T10:00:00-03:00. Sin esto, sale ya.'),
  },
  annotations: { destructiveHint: false, openWorldHint: true },
}, herramienta((a, d) => meta.publicarFacebook(a, d)));

server.registerTool('instagram_publicar', {
  title: 'Publicar en Instagram',
  description: 'Publica en Instagram: una foto, un carrusel (2 a 10 fotos/videos), un reel o una historia. '
    + 'Las fotos tienen que ser JPG. Instagram no permite programar por API. Publica de verdad: confirmá con el usuario antes.',
  inputSchema: {
    caption: z.string().optional().describe('Texto del posteo (hasta 2200 caracteres, 30 hashtags).'),
    medios,
    tipo: z.enum(['feed', 'reel', 'story']).optional().describe('feed (default; foto o carrusel), reel o story.'),
    compartirEnFeed: z.boolean().optional().describe('Para reels: si también aparece en el feed (default true).'),
  },
  annotations: { destructiveHint: false, openWorldHint: true },
}, herramienta((a, d) => meta.publicarInstagram(a, d)));

server.registerTool('instagram_estado', {
  title: 'Terminar una publicación de Instagram pendiente',
  description: 'Si instagram_publicar devolvió que un contenedor seguía procesando (videos largos), esto '
    + 'revisa su estado y lo publica si ya está listo.',
  inputSchema: { contenedor: z.string().describe('Id del contenedor que devolvió instagram_publicar.') },
  annotations: { openWorldHint: true },
}, herramienta((a, d) => meta.finalizarInstagram(a, d)));

server.registerTool('meta_recientes', {
  title: 'Ver publicaciones recientes',
  description: 'Lista las últimas publicaciones de la página de Facebook y/o de Instagram, con su link.',
  inputSchema: {
    plataforma: z.enum(['facebook', 'instagram', 'ambas']).optional(),
    cantidad: z.number().int().min(1).max(25).optional(),
  },
  annotations: { readOnlyHint: true },
}, herramienta((a, d) => meta.recientes(a, d)));

server.connect(new StdioServerTransport()).catch(e => {
  console.error('No pude arrancar el servidor MCP de Meta:', e);
  process.exit(1);
});
