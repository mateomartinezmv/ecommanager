// Infraestructura compartida de los tests: levantar el CRM en un navegador con la API
// mockeada, para poder ejercitar la UI real sin tocar Supabase.
//
// El SPA entero vive en public/index.html, así que no hay módulos que importar ni funciones
// que testear sueltas: la única forma de verificar la lógica de negocio (qué suma a la
// ganancia, qué computa contra el tope del Literal E) es correr la página de verdad.

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

const HOY = new Date().toISOString().slice(0, 10);
// Fecha de hace n días, para armar movimientos dentro y fuera del período del reporte.
const haceDias = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// page.route sólo intercepta http(s), no file://, así que public/ se sirve de verdad.
// Puerto 0 = el sistema elige uno libre: dos suites pueden correr sin pisarse.
function servirPublic() {
  const servidor = http.createServer((req, res) => {
    const archivo = path.join(RAIZ, 'public', req.url.split('?')[0]);
    if (!fs.existsSync(archivo) || !fs.statSync(archivo).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': archivo.endsWith('.html') ? 'text/html' : 'text/plain' });
    res.end(fs.readFileSync(archivo));
  });
  servidor.listen(0);
  return servidor;
}

// Estado del "backend": los tests lo leen para verificar qué se guardó realmente.
function estadoDemo() {
  return {
    productos: [
      { sku: 'SKU1', nombre: 'Slider', tipo: 'nuevo', grupo: 'Sliders', subgrupo: 'Universales',
        stock_dep: 10, stock_meli: 10, stock_shopify: 0, costo: 400, precio: 1000,
        alerta_min: 2, discontinuado: false, created_at: HOY },
      // Dos productos más, de otro grupo, para poder descatalogar y mirar el análisis por
      // grupo sin que quede un solo renglón.
      { sku: 'SKU2', nombre: 'Espejo redondo', tipo: 'nuevo', grupo: 'Espejos', subgrupo: 'Redondos',
        stock_dep: 4, stock_meli: 4, stock_shopify: 0, costo: 250, precio: 700,
        alerta_min: 2, discontinuado: false, created_at: HOY },
      { sku: 'SKU3', nombre: 'Espejo cuadrado', tipo: 'nuevo', grupo: 'Espejos', subgrupo: 'Cuadrados',
        stock_dep: 0, stock_meli: 0, stock_shopify: 0, costo: 300, precio: 800,
        alerta_min: 2, discontinuado: false, created_at: HOY },
    ],
    ventas: [
      { id: 'V-1', canal: 'meli', fecha: HOY, sku: 'SKU1', producto: 'Slider', cantidad: 2,
        precio_unit: 1000, comision: 300, total: 2000, estado: 'completada',
        metodo_pago: 'credito', created_at: HOY },
    ],
    categorias: [
      { id: 'envios', nombre: 'Envíos', tipo: 'ambos', color: '#ef4444', orden: 10 },
      { id: 'packaging', nombre: 'Packaging', tipo: 'gasto', color: '#f59e0b', orden: 20 },
      { id: 'rendimientos', nombre: 'Rendimientos Mercado Pago', tipo: 'ingreso', color: '#22c55e', orden: 30 },
    ],
    movimientos: [
      { id: 'MOV-1', tipo: 'gasto', fecha: HOY, categoria_id: 'packaging',
        concepto: 'Bolsas y burbuja', monto: 1500, moneda: 'UYU', cotizacion: null,
        monto_uyu: 1500, cuenta_facturacion: false, venta_id: null, notas: null },
      { id: 'MOV-2', tipo: 'gasto', fecha: haceDias(1), categoria_id: 'envios',
        concepto: 'Envío cambio orden 2000012345', monto: 320, moneda: 'UYU', cotizacion: null,
        monto_uyu: 320, cuenta_facturacion: false, venta_id: null, notas: 'Cambio de talle' },
      { id: 'MOV-3', tipo: 'ingreso', fecha: HOY, categoria_id: 'rendimientos',
        concepto: 'Rendimientos cuenta MP', monto: 840, moneda: 'UYU', cotizacion: null,
        monto_uyu: 840, cuenta_facturacion: false, venta_id: null, notas: null },
    ],
  };
}

// Responde /api/* desde el estado en memoria, replicando lo que hace api/movimientos.js:
// el cálculo de monto_uyu y el rechazo de borrar una categoría en uso.
// `fallos` permite forzar un error en una ruta (ej: la tabla que todavía no existe).
function mockearApi(page, estado, fallos = {}) {
  return page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const ruta = url.pathname.replace('/api', '');
    const metodo = route.request().method();
    const cuerpo = route.request().postData() ? JSON.parse(route.request().postData()) : {};
    const ok = datos => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(datos) });
    const error = (status, mensaje) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: mensaje }) });

    if (fallos[ruta]) return error(fallos[ruta].status, fallos[ruta].error);

    if (ruta === '/productos') {
      if (metodo === 'PUT') {
        const p = estado.productos.find(x => x.sku === url.searchParams.get('sku'));
        if (!p) return error(404, 'producto inexistente');
        // Réplica de camposDiscontinuado (api/_discontinuado.js): lo que el request no manda
        // se conserva, y reactivar limpia el motivo entero.
        const disc = cuerpo.discontinuado !== undefined ? !!cuerpo.discontinuado : !!p.discontinuado;
        Object.assign(p, {
          nombre: cuerpo.nombre ?? p.nombre,
          grupo: cuerpo.grupo?.trim() || null,
          subgrupo: cuerpo.subgrupo?.trim() || null,
          stock_dep: cuerpo.stockDep ?? p.stock_dep,
          costo: cuerpo.costo ?? p.costo,
          precio: cuerpo.precio ?? p.precio,
          alerta_min: cuerpo.alertaMin ?? p.alerta_min,
          notas: cuerpo.notas ?? p.notas,
          discontinuado: disc,
          motivo_discontinuado: !disc ? null
            : (cuerpo.motivoDiscontinuado !== undefined ? (cuerpo.motivoDiscontinuado || null) : (p.motivo_discontinuado ?? null)),
          nota_discontinuado: !disc ? null
            : (cuerpo.notaDiscontinuado !== undefined ? (String(cuerpo.notaDiscontinuado).trim() || null) : (p.nota_discontinuado ?? null)),
          fecha_discontinuado: !disc ? null
            : (cuerpo.fechaDiscontinuado || p.fecha_discontinuado || HOY),
        });
        // `sinMotivo` imita a una base donde la migración del motivo todavía no corrió: la
        // API guarda el descatalogado y avisa que el motivo no entró.
        if (estado.sinMotivo) {
          p.motivo_discontinuado = null; p.nota_discontinuado = null; p.fecha_discontinuado = null;
          return ok({ ...p, migracionMotivoPendiente: true });
        }
        return ok(p);
      }
      return ok(estado.productos);
    }
    if (ruta === '/ventas') return ok(estado.ventas);
    if (ruta === '/envios') {
      // Un envío nuevo se guarda como lo haría api/envios.js, en snake_case.
      if (metodo === 'POST') {
        const e = { id: cuerpo.id, venta_id: cuerpo.ventaId, orden: cuerpo.orden, comprador: cuerpo.comprador,
          producto: cuerpo.producto, transportista: cuerpo.transportista, tracking: cuerpo.tracking,
          fecha_despacho: cuerpo.fechaDespacho, estado: cuerpo.estado, direccion: cuerpo.direccion,
          costo: cuerpo.costo, zona: cuerpo.zona, colecta: cuerpo.colecta, created_at: HOY };
        (estado.envios = estado.envios || []).push(e);
        return ok(e);
      }
      return ok(estado.envios || []);
    }
    if (ruta === '/clientes') return ok(estado.clientes || []);
    if (ruta === '/importaciones' || ruta === '/devoluciones') return ok([]);
    // La pestaña de Ads: cada suite puede poner su propia respuesta en el estado. Las
    // URLs pedidas se guardan porque lo que *no* se manda también es parte del contrato
    // (ej: sin ?comision el endpoint usa la comisión real en vez de un 15% fijo).
    if (ruta.startsWith('/meli/ads')) {
      (estado.adsRequests = estado.adsRequests || []).push(ruta + url.search);
      if (ruta === '/meli/ads-campanas' && estado.adsCampanas) {
        return ok({ ok: true, periodo: {}, currency: 'UYU', campanas: estado.adsCampanas });
      }
      if (ruta === '/meli/ads-anuncios' && estado.adsAnuncios) return ok(estado.adsAnuncios);
      if (ruta === '/meli/ads-recomendaciones' && estado.adsReco) return ok(estado.adsReco);
      if (ruta === '/meli/ads-economia' && estado.adsEconomia) return ok(estado.adsEconomia);
      if (ruta === '/meli/ads-evolucion' && estado.adsEvolucion) return ok(estado.adsEvolucion);
      // Lo que la pantalla manda a aplicar en MELI se guarda para verificar el cuerpo exacto.
      if (ruta === '/meli/ads-acciones' && metodo === 'POST') {
        (estado.adsAcciones = estado.adsAcciones || []).push(cuerpo);
        return ok({ ok: true, enviado: cuerpo, registrado: true });
      }
      if (ruta === '/meli/ads-cambios') {
        if (metodo === 'POST') {
          (estado.adsCambiosManuales = estado.adsCambiosManuales || []).push(cuerpo);
          return ok({ ok: true });
        }
        if (estado.adsCambios) return ok(estado.adsCambios);
      }
      return ok({ ok: true, total_spend: 0, dias_con_datos: 0 });
    }

    // Las fotos de cada publicación contra las de su original. El POST hace lo que hace el
    // endpoint: deja a cada ángulo corregible con las fotos de la original, y no toca las
    // que MELI no deja (catálogo, cerradas).
    if (ruta === '/meli/fotos') {
      const fotos = estado.fotos || { ok: true, productos: [], resumen: {} };
      if (metodo === 'POST') {
        (estado.fotosPost = estado.fotosPost || []).push(cuerpo);
        const resultados = [];
        for (const prod of fotos.productos) {
          if (cuerpo.sku && prod.sku !== cuerpo.sku) continue;
          for (const pub of prod.publicaciones) {
            if (!pub.copiable) continue;
            resultados.push({ ok: true, sku: prod.sku, meli_id: pub.meli_id, titulo: pub.titulo, antes: pub.fotos.length, ahora: prod.original.fotos.length, modo: 'id', aviso: null });
            pub.fotos = prod.original.fotos.map(f => ({ ...f }));
            pub.distintas = false; pub.copiable = false; pub.motivo = null;
          }
          prod.distintas = prod.publicaciones.filter(x => x.distintas).length;
          prod.copiables = prod.publicaciones.filter(x => x.copiable).length;
          prod.trabadas = prod.publicaciones.filter(x => x.distintas && x.motivo).length;
        }
        fotos.resumen = {
          ...fotos.resumen,
          distintas: fotos.productos.reduce((s, x) => s + x.distintas, 0),
          copiables: fotos.productos.reduce((s, x) => s + x.copiables, 0),
          trabadas: fotos.productos.reduce((s, x) => s + x.trabadas, 0),
          productos_afectados: fotos.productos.filter(x => x.distintas > 0).length,
        };
        return ok({ ok: true, copiadas: resultados.length, fallidas: 0, resultados });
      }
      return ok(fotos);
    }

    if (ruta === '/movimientos') {
      const esCategoria = url.searchParams.get('recurso') === 'categoria';
      const id = url.searchParams.get('id');

      if (metodo === 'GET') return ok({ movimientos: estado.movimientos, categorias: estado.categorias });

      if (esCategoria) {
        if (metodo === 'POST') {
          const nuevoId = cuerpo.nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_');
          const cat = { id: nuevoId, nombre: cuerpo.nombre, tipo: cuerpo.tipo, color: cuerpo.color, orden: 100 };
          estado.categorias.push(cat);
          return ok(cat);
        }
        if (metodo === 'DELETE') {
          const enUso = estado.movimientos.filter(m => m.categoria_id === id).length;
          if (enUso > 0) return error(409, `La categoría tiene ${enUso} movimientos cargados. Cambiales la categoría antes de eliminarla.`);
          estado.categorias = estado.categorias.filter(c => c.id !== id);
          return ok({ ok: true });
        }
      }

      if (metodo === 'POST') {
        const mov = {
          id: 'MOV-' + Date.now() + '-' + estado.movimientos.length,
          tipo: cuerpo.tipo, fecha: cuerpo.fecha, categoria_id: cuerpo.categoriaId,
          concepto: cuerpo.concepto, monto: cuerpo.monto, moneda: cuerpo.moneda,
          cotizacion: cuerpo.moneda === 'USD' ? cuerpo.cotizacion : null,
          monto_uyu: cuerpo.moneda === 'USD' ? cuerpo.monto * cuerpo.cotizacion : cuerpo.monto,
          cuenta_facturacion: !!cuerpo.cuentaFacturacion, venta_id: null, notas: cuerpo.notas || null,
        };
        estado.movimientos.unshift(mov);
        return ok(mov);
      }
      if (metodo === 'DELETE') {
        estado.movimientos = estado.movimientos.filter(m => m.id !== id);
        return ok({ ok: true });
      }
    }

    return ok([]);
  });
}

// Abre el CRM con la API mockeada y espera a que termine de cargar los datos.
// Devuelve además los errores de consola y los alert() que aparezcan, para que cada suite
// pueda exigir que la pantalla no haya roto nada por el camino.
async function abrirCRM({ estado, fallos, viewport } = {}) {
  estado = estado || estadoDemo();
  const servidor = servirPublic();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage(viewport ? { viewport } : {});

  const errores = [];
  const alertas = [];
  page.on('pageerror', e => errores.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text()); });
  page.on('dialog', async d => { alertas.push(d.message()); await d.accept(); });

  await mockearApi(page, estado, fallos);
  await page.goto(`http://127.0.0.1:${servidor.address().port}/index.html`);
  // `let db` es una binding léxica del script, no una propiedad de window.
  await page.waitForFunction(() => typeof db !== 'undefined' && db.ventas.length > 0, { timeout: 20000 });

  const cerrar = async () => { await browser.close(); servidor.close(); };
  return { page, estado, errores, alertas, cerrar };
}

// Los CDN (jsPDF, jsBarcode) no cargan sin red y no hacen a lo que se está probando.
function erroresReales(errores, ignorarExtra = []) {
  const ruido = [/favicon/i, /ERR_FILE_NOT_FOUND/, /ERR_TUNNEL_CONNECTION_FAILED/, /ERR_NAME_NOT_RESOLVED/, /cdnjs/i, /jspdf/i, /jsbarcode/i, ...ignorarExtra];
  return errores.filter(e => !ruido.some(r => r.test(e)));
}

// Lee las tarjetas de estadísticas de una pantalla como { etiqueta: valor }.
function leerTarjetas(page, selector) {
  return page.$$eval(selector + ' .stat-card', els => els.map(e => ({
    etiqueta: e.querySelector('.stat-label').textContent.trim(),
    valor: e.querySelector('.stat-value').textContent.trim(),
  })));
}

module.exports = { HOY, haceDias, estadoDemo, abrirCRM, erroresReales, leerTarjetas, servirPublic };
