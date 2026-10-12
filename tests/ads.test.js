// La pestaña de Ads: el ROAS de equilibrio que se muestra y la sección que dice qué anunciar.
//
// Las dos cosas que se protegen acá son decisiones de plata:
//
//   1. Que el margen se calcule con la comisión real y el envío. La pantalla mandaba
//      siempre ?comision=15 y el endpoint no restaba envío, así que el ROAS de equilibrio
//      salía 1,9x cuando el real era 2,4x — y con eso un anuncio a 2,2x figuraba en verde
//      mientras perdía plata en cada venta.
//   2. Que "Qué anunciar" liste productos que NO están en ninguna campaña. Es toda la
//      razón de ser de la sección: el panel de MELI sólo muestra lo que ya se anuncia.

const { test } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, estadoDemo, erroresReales, leerTarjetas } = require('./helpers');

/** Estado con la pestaña de Ads poblada, con números tomados del negocio real. */
function estadoConAds(extra = {}) {
  const estado = estadoDemo();
  estado.adsCampanas = [
    { id: '358477958', nombre: 'Campaña principal', inversion: 13983, roas: 4.13 },
  ];
  estado.adsAnuncios = {
    ok: true,
    periodo: { desde: '2026-09-12', hasta: '2026-10-11' },
    campaign_id: '358477958',
    currency: 'UYU',
    comision_pct: 14.33,
    totales: {
      anuncios: 2, impresiones: 50000, clics: 1671, inversion: 13983, facturacion: 57691,
      unidades: 30, roas: 4.13, ganancia: 9000, anuncios_con_costo: 2,
      anuncios_sin_vincular: 0, anuncios_sku_sin_vincular: 0, truncado: null, cvr_campana: 1.8,
      margen_ponderado: 41.8,
      roas_breakeven_campana: 2.39,
      economia: {
        comision_pct: 14.33, comision_es_manual: false, envio_unitario: 165,
        envios: { total: 247, con_costo: 111, sin_costo: 136, promedio_real: 202.69, fallback_usado: 202.69, estimados: 136 },
        periodo: { desde: '2026-04-15', hasta: '2026-10-11', dias: 180 },
        ventas_muestra: 501,
      },
    },
    anuncios: [
      {
        ad_group_id: '1', campaign_id: '358477958', titulo: 'Baúl Trasero Moto 45L', thumbnail: null,
        status: 'ACTIVE', item_ids: ['MLU111'], variantes: 1, permalink: null,
        impresiones: 30000, clics: 1000, inversion: 8000, facturacion: 40000, unidades: 10,
        ctr: 3.3, cpc: 8, cvr: 1, roas: 5, acos: 20, tacos: 0, sov: 0,
        unidades_organicas: 2, facturacion_organica: 8000,
        precio_publicado: 3990, precio_real: 3990, sku: 'AP-TAILBOXSQ', costo: 948,
        comision_pct: 14.33, comision: 571.77, envio_unitario: 165,
        contribucion: 2305.23, margen: 57.78, roas_breakeven: 1.73,
        economia_fuente: 'sku', economia_muestra: 17,
        cpa_max: 2305.23, cpc_max: 23.05, cpc_max_estimado: 23.05, cpc_max_es_estimado: false,
        cvr_referencia: 1, deficit: -15052, ventas_para_empatar: 0, ganancia: 15052,
        sin_vincular: false, sku_sin_vincular: false, estado: 'ganando',
      },
      {
        // El caso que la cuenta vieja pintaba de verde: ROAS 2,2x contra un equilibrio real
        // de 2,87x. Con comisión fija y sin envío su equilibrio daba 2,37x y "ganaba".
        ad_group_id: '2', campaign_id: '358477958', titulo: 'Gato Soporte Elevador', thumbnail: null,
        status: 'ACTIVE', item_ids: ['MLU222'], variantes: 1, permalink: null,
        impresiones: 20000, clics: 671, inversion: 5983, facturacion: 17691, unidades: 6,
        ctr: 3.3, cpc: 8.9, cvr: 0.89, roas: 2.2, acos: 45.4, tacos: 0, sov: 0,
        unidades_organicas: 0, facturacion_organica: 0,
        precio_publicado: 2730, precio_real: 2730, sku: 'GZTYJ-41046N', costo: 1380,
        comision_pct: 14.33, comision: 391.21, envio_unitario: 165,
        contribucion: 793.79, margen: 29.08, roas_breakeven: 3.44,
        economia_fuente: 'sku', economia_muestra: 7,
        cpa_max: 793.79, cpc_max: 7.06, cpc_max_estimado: 7.06, cpc_max_es_estimado: false,
        cvr_referencia: 0.89, deficit: 1220, ventas_para_empatar: 2, ganancia: -1220,
        sin_vincular: false, sku_sin_vincular: false, estado: 'perdiendo',
      },
    ],
  };
  estado.adsReco = {
    ok: true,
    periodo: { desde: '2026-09-12', hasta: '2026-10-11', dias: 30 },
    periodo_previo: { desde: '2026-08-13', hasta: '2026-09-11' },
    currency: 'UYU',
    ads_disponible: true, error_ads: null, ads_incompleto: null,
    economia: { comision_pct: 14.33, envio_unitario: 165, envios: { sin_costo: 136, con_costo: 111, total: 247, fallback_usado: 202.69 } },
    resumen: {
      catalogo: 76, evaluados: 55, con_recomendacion: 3,
      anuncios_leidos: 20, skus_anunciados: 12,
      descartados: { discontinuados: 9, sin_costo: 5, sin_publicar: 7 },
      por_motivo: [
        { motivo: 'ganador_sin_anunciar', productos: 1, plata: 6915 },
        { motivo: 'se_apago_y_andaba', productos: 1, plata: 4200 },
        { motivo: 'anunciado_sin_stock', productos: 1, plata: 800 },
      ],
    },
    recomendaciones: [
      {
        sku: 'HSJ-20121', nombre: 'Espejos Moto Tipo Aleron Grande', motivo: 'ganador_sin_anunciar',
        accion: 'Empezar a anunciar', urgencia: 'alta', plata_en_juego: 6915,
        detalle: 'Vendió 9 unidades sin un peso de publicidad, con 55.4% de margen.',
        margen: 55.4, roas_breakeven: 1.81, contribucion: 768.33, precio: 1386, costo: 400,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        stock: 18, stock_publicado: 18, meses_stock: 2, unidades_periodo: 9,
        unidades_organicas: 9, unidades_previas: 11, ads: null, anunciado: false,
        otros_motivos: [],
      },
      {
        sku: 'DFB-002', nombre: 'Deflector Parabrisas', motivo: 'se_apago_y_andaba',
        accion: 'Volver a prenderlo', urgencia: 'alta', plata_en_juego: 4200,
        detalle: 'Invertiste 2100 a ROAS 3.80x (equilibrio 2.42x) y vendió 7 unidades. En este período no gastó nada.',
        margen: 41.3, roas_breakeven: 2.42, contribucion: 722, precio: 1750, costo: 540,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        stock: 9, stock_publicado: 9, meses_stock: 3, unidades_periodo: 3,
        unidades_organicas: 3, unidades_previas: 7,
        ads: { ahora: { clics: 0, inversion: 0, unidades: 0, facturacion: 0, roas: 0 } },
        anunciado: false, otros_motivos: [],
      },
      {
        sku: 'AP-TAILBOXLED', nombre: 'Baúl Trasero Moto 28L', motivo: 'anunciado_sin_stock',
        accion: 'Pausar ya', urgencia: 'alta', plata_en_juego: 800,
        detalle: 'Gastaste 800 en ads de un producto sin stock en el depósito.',
        margen: 22.1, roas_breakeven: 4.52, contribucion: 387, precio: 1750, costo: 800,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        stock: 0, stock_publicado: 0, meses_stock: null, unidades_periodo: 1,
        unidades_organicas: 0, unidades_previas: 2,
        ads: { ahora: { clics: 90, inversion: 800, unidades: 1, facturacion: 1750, roas: 2.19 } },
        anunciado: true,
        otros_motivos: [{ motivo: 'margen_flaco', detalle: 'Haría falta ROAS 4.52x para empatar.' }],
      },
    ],
  };
  return Object.assign(estado, extra);
}

/** Abre el CRM y entra a la pestaña de Ads, esperando a que pinte la tabla. */
async function irAAds(estado) {
  const crm = await abrirCRM({ estado });
  await crm.page.click('.nav-item:has-text("Ads MELI")');
  await crm.page.waitForSelector('#ads-tabla table', { timeout: 15000 });
  return crm;
}

test('el ROAS de equilibrio de la campaña se muestra y se compara contra el real', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    const tarjetas = await leerTarjetas(crm.page, '#ads-stats');
    const be = tarjetas.find(t => t.etiqueta.startsWith('ROAS de equilibrio'));
    assert.ok(be, 'falta la tarjeta del ROAS de equilibrio');
    assert.strictEqual(be.valor, '2.39x');
    // La etiqueta tiene que decir de qué está hecho: sin eso es un número caído del cielo.
    assert.match(be.etiqueta, /margen 41\.8%/);
    assert.match(be.etiqueta, /comisión 14\.33%/);
    assert.match(be.etiqueta, /envío/);

    // ROAS real 4,13x contra equilibrio 2,39x: sobra colchón, va en verde.
    const clase = await crm.page.$eval('#ads-stats .stat-card:has-text("ROAS de equilibrio")', e => e.className);
    assert.match(clase, /green/);
  } finally { await crm.cerrar(); }
});

test('la pantalla no impone un 15% de comisión: deja que el endpoint mida la real', async () => {
  const estado = estadoConAds();
  const crm = await irAAds(estado);
  try {
    const pedidos = (estado.adsRequests || []).filter(u => u.startsWith('/meli/ads-anuncios'));
    assert.ok(pedidos.length, 'no se pidieron los anuncios');
    for (const u of pedidos) {
      assert.ok(!u.includes('comision='), `el request todavía fuerza la comisión: ${u}`);
      assert.ok(!u.includes('envio='), `el request todavía fuerza el envío: ${u}`);
    }
  } finally { await crm.cerrar(); }
});

test('forzar la comisión a mano sí la manda: el override sigue disponible para simular', async () => {
  const estado = estadoConAds();
  const crm = await irAAds(estado);
  try {
    // El campo vive en el panel de rango personalizado, que sólo aparece con ese período.
    await crm.page.selectOption('#ads-periodo', 'custom');
    await crm.page.waitForSelector('#ads-comision', { state: 'visible' });
    await crm.page.fill('#ads-comision', '12');
    // `fill` manda `input`, no `change`: el onchange del campo necesita el evento real.
    await crm.page.dispatchEvent('#ads-comision', 'change');
    await crm.page.waitForTimeout(500);

    const pedidos = (estado.adsRequests || []).filter(u => u.startsWith('/meli/ads-anuncios'));
    assert.ok(pedidos.some(u => u.includes('comision=12')), 'no se mandó la comisión elegida');
  } finally { await crm.cerrar(); }
});

test('los envíos sin costo cargado se avisan: el margen de esa cuenta está estimado', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    const aviso = await crm.page.textContent('#ads-aviso');
    assert.match(aviso, /136 de 247 envíos entraron al CRM sin costo/);
    // Y tiene que decir qué se hizo al respecto, no sólo que falta el dato.
    assert.match(aviso, /se completaron con/);
  } finally { await crm.cerrar(); }
});

test('el tooltip del ROAS de equilibrio muestra la cuenta entera, envío incluido', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    const titulo = await crm.page.$eval('#ads-tabla tbody tr:first-child td:nth-child(10)', e => e.getAttribute('title'));
    assert.match(titulo, /de precio/);
    assert.match(titulo, /de costo/);
    assert.match(titulo, /de comisión/);
    assert.match(titulo, /de envío/);
    assert.match(titulo, /medidos sobre las ventas de este SKU/);
  } finally { await crm.cerrar(); }
});

test('Qué anunciar lista productos que no están en ninguna campaña', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');

    // Un ganador orgánico sin un solo anuncio: lo que el panel de MELI no puede ver.
    assert.match(texto, /Espejos Moto Tipo Aleron Grande/);
    assert.match(texto, /Empezar a anunciar/);
    assert.match(texto, /sin ads en el período/);

    // Uno que se anunciaba y se apagó, con lo que rendía cuando estaba prendido.
    assert.match(texto, /Deflector Parabrisas/);
    assert.match(texto, /Volver a prenderlo/);

    // Y uno que hay que apagar ya: se está gastando en algo sin stock.
    assert.match(texto, /Baúl Trasero Moto 28L/);
    assert.match(texto, /Pausar ya/);
    // Los motivos secundarios también se muestran: un producto puede estar mal por más
    // de una razón y quedarse con la primera esconde la mitad del problema.
    assert.match(texto, /Haría falta ROAS 4\.52x/);
  } finally { await crm.cerrar(); }
});

test('los chips filtran por motivo y el contador dice cuánta plata hay en cada uno', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-chips button', { timeout: 15000 });
    const chips = await crm.page.$$eval('#ads-reco-chips button', els => els.map(e => e.textContent.trim()));
    assert.ok(chips.some(c => /Todo/.test(c) && /3/.test(c)), `chips: ${chips.join(' | ')}`);
    assert.ok(chips.some(c => /Ganador sin anunciar/.test(c)));

    await crm.page.click('#ads-reco-chips button:has-text("Ganador sin anunciar")');
    await crm.page.waitForTimeout(200);
    const texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /Espejos Moto Tipo Aleron Grande/);
    assert.ok(!/Deflector Parabrisas/.test(texto), 'el filtro no sacó los otros motivos');
  } finally { await crm.cerrar(); }
});

test('los productos sin costo quedan afuera y la pantalla dice que quedaron afuera', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    // Silenciarlos haría parecer que el catálogo está cubierto cuando hay cinco productos
    // sobre los que no se puede opinar.
    assert.match(texto, /5 producto\(s\) quedaron afuera por no tener costo/);
    assert.match(texto, /55 productos publicados evaluados/);
  } finally { await crm.cerrar(); }
});

test('sin acceso a MELI Ads la sección sigue sirviendo, pero lo aclara', async () => {
  const estado = estadoConAds();
  estado.adsReco = {
    ...estado.adsReco,
    ads_disponible: false,
    error_ads: 'La cuenta no tiene perfil de anunciante en MELI Ads.',
  };
  const crm = await irAAds(estado);
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /No se pudo leer MELI Ads/);
    assert.match(texto, /no se puede distinguir lo que ya estás anunciando/);
    // Las recomendaciones igual se muestran: el catálogo y las ventas alcanzan.
    assert.match(texto, /Espejos Moto Tipo Aleron Grande/);
  } finally { await crm.cerrar(); }
});

test('no hubo errores ni alertas en la pestaña de Ads', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    await crm.page.click('#ads-reco-chips button:has-text("Todo")');
    await crm.page.waitForTimeout(200);
    assert.deepStrictEqual(erroresReales(crm.errores), []);
    assert.deepStrictEqual(crm.alertas, []);
  } finally { await crm.cerrar(); }
});
