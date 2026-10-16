// La pestaña de Ads: el ROAS de equilibrio que se muestra y la sección que dice qué anunciar.
//
// Las dos cosas que se protegen acá son decisiones de plata:
//
//   1. Que el margen se calcule con la comisión real y el envío. La pantalla mandaba
//      siempre ?comision=15 y el endpoint no restaba envío, así que el ROAS de equilibrio
//      salía 1,9x cuando el real era 2,4x — y con eso un anuncio a 2,2x figuraba en verde
//      mientras perdía plata en cada venta.
//   2. Que "Qué anunciar y qué apagar" liste productos que NO están en ninguna campaña.
//      Es toda la razón de ser de la sección: el panel de MELI sólo muestra lo que ya se
//      anuncia, así que un producto con 55% de margen y sin una impresión no aparece en
//      ningún lado.
//   3. Que el histórico frene las recomendaciones. Volver a prender un anuncio que perdía
//      plata es repetir el error con más convicción, y parte de ese historial vive sólo en
//      el snapshot diario local: pasados los 90 días, MELI no lo tiene más.

const { test } = require('node:test');
const assert = require('node:assert');
const { abrirCRM, estadoDemo, erroresReales, leerTarjetas } = require('./helpers');

/** Estado con la pestaña de Ads poblada, con números tomados del negocio real. */
function estadoConAds(extra = {}) {
  const estado = estadoDemo();
  estado.adsCampanas = [
    { id: '358477958', nombre: 'TEST - muchos ads', inversion: 13983, roas: 4.13 },
    { id: '999000111', nombre: 'WINNERS', inversion: 2400, roas: 6.10 },
  ];
  estado.adsAnuncios = {
    ok: true,
    periodo: { desde: '2026-09-12', hasta: '2026-10-11' },
    campaign_id: 'todas',
    todas_las_campanas: true,
    currency: 'UYU',
    comision_pct: 14.33,
    totales: {
      anuncios: 2, impresiones: 50000, clics: 1671, inversion: 13983, facturacion: 57691,
      unidades: 30, roas: 4.13, ganancia: 9000, anuncios_con_costo: 2,
      anuncios_sin_vincular: 0, anuncios_sku_sin_vincular: 0, truncado: null, cvr_campana: 1.8,
      margen_ponderado: 41.8,
      roas_breakeven_campana: 2.39,
      campana: {
        nombre: '2 campañas con gasto', impresiones: 50000, clics: 1671,
        inversion: 16383, facturacion: 72331, unidades: 36, roas: 4.41,
        campanas: [
          { id: '358477958', nombre: 'TEST - muchos ads', inversion: 13983, facturacion: 57691, roas: 4.13 },
          { id: '999000111', nombre: 'WINNERS', inversion: 2400, facturacion: 14640, roas: 6.1 },
        ],
      },
      economia: {
        comision_pct: 14.33, comision_es_manual: false, envio_unitario: 165,
        envios: { total: 247, con_costo: 111, sin_costo: 136, promedio_real: 202.69, fallback_usado: 202.69, estimados: 136 },
        periodo: { desde: '2026-04-15', hasta: '2026-10-11', dias: 180 },
        ventas_muestra: 501,
      },
    },
    anuncios: [
      {
        ad_group_id: '1', campaign_id: '358477958', campaign_name: 'TEST - muchos ads',
        titulo: 'Baúl Trasero Moto 45L', thumbnail: null,
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
        ad_group_id: '2', campaign_id: '999000111', campaign_name: 'WINNERS',
        titulo: 'Gato Soporte Elevador', thumbnail: null,
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
    periodo_historico: { desde: '2026-07-14', hasta: '2026-10-11', dias: 90 },
    currency: 'UYU',
    economia: { comision_pct: 14.33, comision_es_manual: false, envio_unitario: 165, ventas_muestra: 501,
      envios: { total: 247, con_costo: 111, sin_costo: 136, promedio_real: 202.69, fallback_usado: 202.69, estimados: 136 } },
    referencia: { campanas: 1, clics: 1671, inversion: 13983, unidades: 30, cpc: 8.4, cvr: 1.8, cpa: 467,
      ad_groups: 20, anuncios_activos: 12 },
    resumen: {
      catalogo: 76, evaluados: 55, con_recomendacion: 6, mostrados: 6,
      anunciados: 3, sin_anunciar: 3, con_historico: 3,
      snapshot_historico: true, incompleto: null,
      descartados: { discontinuados: 9, sin_publicacion: 7, sin_costo: 5, sin_precio: 0, sin_publicacion_activa: 2 },
      por_motivo: [
        { motivo: 'ganador_sin_anunciar', familia: 'anunciar', productos: 1, plata: 6915 },
        { motivo: 'se_apago_y_andaba', familia: 'anunciar', productos: 1, plata: 4200 },
        { motivo: 'anunciado_sin_stock', familia: 'ajustar', productos: 1, plata: 800 },
        { motivo: 'ya_fallo', familia: 'anunciar', productos: 1, plata: 0 },
        { motivo: 'escalar', familia: 'ajustar', productos: 1, plata: 2100 },
        { motivo: 'en_varias_campanas', familia: 'ajustar', productos: 1, plata: 1200 },
      ],
    },
    recomendaciones: [
      {
        sku: 'HSJ-20121', nombre: 'Espejos Moto Tipo Aleron Grande', grupo: 'Espejos',
        familia: 'anunciar', motivo: 'ganador_sin_anunciar', accion: 'Empezar a anunciar',
        urgencia: 'alta', plata_en_juego: 6915,
        detalle: 'Nunca se anunció. Vendió 9 unidades sin un peso de publicidad, con 55.4% de margen.',
        margen: 55.4, roas_breakeven: 1.81, contribucion: 768.33, precio: 1386, costo: 400,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        meli_id: 'MLU333', permalink: 'https://articulo.mercadolibre.com.uy/MLU333', thumbnail: null,
        estado_publicacion: 'active', publicaciones: 1,
        stock: 18, stock_dep: 18, meses_stock: 2, unidades_meli_periodo: 9, unidades_mes: 3,
        anunciado: false, ad_groups: [], ads_ahora: null,
        historico: null, veredicto_historico: null,
        cpc_max: 13.8, cpa_estimado: 467, ganancia_por_venta: 301.33, cvr_referencia: 1.8, cvr_origen: 'cuenta',
        otros_motivos: [],
      },
      {
        sku: 'DFB-002', nombre: 'Deflector Parabrisas', grupo: 'Parabrisas',
        familia: 'anunciar', motivo: 'se_apago_y_andaba', accion: 'Volver a prenderlo',
        urgencia: 'alta', plata_en_juego: 4200,
        detalle: 'Estuvo anunciándose y ya no está en la campaña. Cuando corría invirtió 2100 a ROAS 3.80x (equilibrio 2.42x) y vendió 7 unidades.',
        margen: 41.3, roas_breakeven: 2.42, contribucion: 722, precio: 1750, costo: 540,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        meli_id: 'MLU444', permalink: null, thumbnail: null,
        estado_publicacion: 'active', publicaciones: 1,
        stock: 9, stock_dep: 9, meses_stock: 3, unidades_meli_periodo: 3, unidades_mes: 2,
        anunciado: false, ad_groups: ['77'], ads_ahora: null,
        historico: { inversion: 2100, unidades: 7, clics: 310, roas: 3.8, cpc: 6.8, cvr: 2.3,
          desde: '2026-07-14', hasta: '2026-08-20', fuente: 'ambas', campanas: ['Campaña principal'], dias_locales: 12 },
        veredicto_historico: 'rentable',
        cpc_max: 16.6, cpa_estimado: 467, ganancia_por_venta: 255, cvr_referencia: 2.3, cvr_origen: 'propio',
        otros_motivos: [],
      },
      {
        sku: 'AP-TAILBOXLED', nombre: 'Baúl Trasero Moto 28L', grupo: 'Baúles',
        familia: 'ajustar', motivo: 'anunciado_sin_stock', accion: 'Pausar ya',
        urgencia: 'alta', plata_en_juego: 800,
        detalle: 'Gastaste 800 en ads de una publicación sin stock en MELI.',
        margen: 22.1, roas_breakeven: 4.52, contribucion: 387, precio: 1750, costo: 800,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        meli_id: 'MLU555', permalink: null, thumbnail: null,
        estado_publicacion: 'active', publicaciones: 1,
        stock: 0, stock_dep: 0, meses_stock: null, unidades_meli_periodo: 1, unidades_mes: 1,
        anunciado: true, ad_groups: ['88'],
        campanas_activas: ['TEST - muchos ads'],
        ads_ahora: { clics: 90, inversion: 800, unidades: 1, facturacion: 1750, roas: 2.19, impresiones: 3000 },
        historico: null, veredicto_historico: null,
        cpc_max: 7, cpa_estimado: 467, ganancia_por_venta: -80, cvr_referencia: 1.8, cvr_origen: 'cuenta',
        otros_motivos: [{ motivo: 'margen_flaco', detalle: 'Haría falta ROAS 4.52x para empatar.' }],
      },
      {
        // Un producto que quedó en las dos campañas: los winners salen de la campaña
        // vieja y suelen quedar también en ella.
        sku: 'HSJ-20121-B', nombre: 'Espejos Aleron Chico', grupo: 'Espejos',
        familia: 'ajustar', motivo: 'en_varias_campanas', accion: 'Dejarlo en una sola',
        urgencia: 'alta', plata_en_juego: 1200,
        detalle: 'Está corriendo en 2 campañas a la vez (TEST - muchos ads y WINNERS). Son dos anuncios tuyos compitiendo en la misma subasta: te suben el CPC entre ellos y parten el presupuesto.',
        margen: 50, roas_breakeven: 2, contribucion: 600, precio: 1200, costo: 400,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        meli_id: 'MLU888', permalink: null, thumbnail: null,
        estado_publicacion: 'active', publicaciones: 1,
        stock: 12, stock_dep: 12, meses_stock: 4, unidades_meli_periodo: 3, unidades_mes: 3,
        anunciado: true, ad_groups: ['11', '22'],
        campanas_activas: ['TEST - muchos ads', 'WINNERS'],
        ads_ahora: { clics: 140, inversion: 1200, unidades: 4, facturacion: 4800, roas: 4, impresiones: 9000 },
        historico: null, veredicto_historico: null,
        cpc_max: 10, cpa_estimado: 467, ganancia_por_venta: 133, cvr_referencia: 1.8, cvr_origen: 'cuenta',
        otros_motivos: [],
      },
      {
        // El caso que destapó dos bugs: tres colores de un mismo manillar cuelgan de UN
        // ad group de 5 variantes. Cada uno mostraba el gasto entero del anuncio, y el
        // acumulado decía "cuando se anunciaba" aunque el anuncio esté corriendo ahora.
        sku: 'HP-CB0382', nombre: 'Manillar Universal Aluminio Para Moto 22mm - Blanco', grupo: 'Manillares',
        familia: 'ajustar', motivo: 'escalar', accion: 'Subir presupuesto',
        urgencia: 'media', plata_en_juego: 2100,
        detalle: 'ROAS 9.40x contra un equilibrio de 3.28x: cada peso de ads deja 1.86 limpios. Hay 5 unidades publicadas para sostenerlo.',
        margen: 30.46, roas_breakeven: 3.28, contribucion: 362, precio: 1190, costo: 640,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        meli_id: 'MLU777', permalink: null, thumbnail: null,
        estado_publicacion: 'active', publicaciones: 1,
        stock: 5, stock_dep: 5, meses_stock: null, unidades_meli_periodo: 0, unidades_mes: 0,
        anunciado: true, ad_groups: ['7068115768680593'],
        campanas_activas: ['TEST - muchos ads'],
        // Un tercio del anuncio: $1.002 repartidos entre los tres colores.
        compartido_con: 3,
        ads_ahora: { clics: 79, inversion: 334, unidades: 3, facturacion: 3140, roas: 9.4, impresiones: 7755 },
        historico: { inversion: 599, unidades: 4, clics: 180, roas: 7.12, cpc: 3.3, cvr: 2.2,
          desde: '2026-07-15', hasta: '2026-10-12', fuente: 'api', campanas: ['Campaña principal'], dias_locales: 0 },
        veredicto_historico: 'rentable',
        cpc_max: 9, cpa_estimado: 467, ganancia_por_venta: -105, cvr_referencia: 1.8, cvr_origen: 'cuenta',
        otros_motivos: [],
      },
      {
        // El que el histórico salva de un error: parece una oportunidad y ya falló.
        sku: 'HP-ZJ039', nombre: 'Posapies Aluminio CNC', grupo: 'Posapies',
        familia: 'anunciar', motivo: 'ya_fallo', accion: 'No volver sin cambiar algo',
        urgencia: 'baja', plata_en_juego: 0,
        detalle: 'Estuvo anunciándose y ya no está en la campaña. Cuando se anunciaba invirtió 3100 a ROAS 1.40x, debajo del equilibrio de 4.70x. Volver a prenderlo sin tocar precio ni publicación repite el resultado.',
        margen: 21.3, roas_breakeven: 4.7, contribucion: 320, precio: 1500, costo: 820,
        comision_pct: 14.33, envio_unitario: 165, economia_fuente: 'sku',
        meli_id: 'MLU666', permalink: null, thumbnail: null,
        estado_publicacion: 'active', publicaciones: 1,
        stock: 5, stock_dep: 5, meses_stock: 5, unidades_meli_periodo: 1, unidades_mes: 1,
        anunciado: false, ad_groups: ['99'], ads_ahora: null,
        historico: { inversion: 3100, unidades: 3, clics: 420, roas: 1.4, cpc: 7.4, cvr: 0.7,
          desde: '2026-05-01', hasta: '2026-06-15', fuente: 'local', campanas: ['Campaña vieja'], dias_locales: 45 },
        veredicto_historico: 'perdia',
        cpc_max: 2.2, cpa_estimado: 467, ganancia_por_venta: -147, cvr_referencia: 1.8, cvr_origen: 'cuenta',
        otros_motivos: [],
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
    const titulo = await crm.page.$eval('#ads-tabla tbody tr:first-child td:nth-child(11)', e => e.getAttribute('title'));
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
    assert.match(texto, /sin ads activo/);

    // Uno que se anunciaba y se apagó, con lo que rendía cuando estaba prendido.
    assert.match(texto, /Deflector Parabrisas/);
    assert.match(texto, /Volver a prenderlo/);

    // Y uno que hay que apagar ya: se está gastando en algo sin stock en MELI.
    assert.match(texto, /Baúl Trasero Moto 28L/);
    assert.match(texto, /Pausar ya/);
    // Los motivos secundarios también se muestran: un producto puede estar mal por más
    // de una razón y quedarse con la primera esconde la mitad del problema.
    assert.match(texto, /Haría falta ROAS 4\.52x/);
  } finally { await crm.cerrar(); }
});

test('el histórico frena la recomendación de volver a anunciar algo que ya perdía', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');

    // Por margen y stock parecería una oportunidad. El histórico dice que no: se anunció
    // a ROAS 1,40x contra un equilibrio de 4,70x. Recomendarlo sería repetir el error.
    assert.match(texto, /Posapies Aluminio CNC/);
    assert.match(texto, /No volver sin cambiar algo/);
    assert.match(texto, /cuando se anunciaba, perdía/);
    // Y tiene que verse de dónde sale ese histórico, porque parte vive sólo en el snapshot.
    assert.match(texto, /3100 invertidos|\$\s?3[.,]?100/);
    assert.match(texto, /histórico guardado/);
  } finally { await crm.cerrar(); }
});

test('el histórico que suma MELI y el snapshot dice que viene de los dos lados', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /MELI \+ guardado/);
    assert.match(texto, /cuando se anunciaba, pagaba/);
  } finally { await crm.cerrar(); }
});

test('los chips separan lo que ya anunciás de lo que falta, y filtran por motivo', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-chips button', { timeout: 15000 });
    const chips = await crm.page.$$eval('#ads-reco-chips button', els => els.map(e => e.textContent.trim()));
    assert.ok(chips.some(c => /Todo/.test(c) && /6/.test(c)), `chips: ${chips.join(' | ')}`);
    assert.ok(chips.some(c => /Lo que ya anunciás/.test(c)));
    assert.ok(chips.some(c => /Lo que falta anunciar/.test(c)));
    assert.ok(chips.some(c => /Ganador sin anunciar/.test(c)));

    // La familia: sólo lo que ya se anuncia.
    await crm.page.click('#ads-reco-chips button:has-text("Lo que ya anunciás")');
    await crm.page.waitForTimeout(200);
    let texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /Baúl Trasero Moto 28L/);
    assert.ok(!/Espejos Moto Tipo Aleron Grande/.test(texto), 'la familia no filtró');

    // Y el motivo puntual.
    await crm.page.click('#ads-reco-chips button:has-text("Ganador sin anunciar")');
    await crm.page.waitForTimeout(200);
    texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /Espejos Moto Tipo Aleron Grande/);
    assert.ok(!/Deflector Parabrisas/.test(texto), 'el filtro por motivo no sacó los otros');
  } finally { await crm.cerrar(); }
});

test('los productos que quedaron afuera se dicen, no se esconden', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    // Silenciarlos haría parecer que el catálogo está cubierto cuando hay productos
    // sobre los que no se puede opinar.
    assert.match(texto, /5 producto\(s\) quedaron afuera por no tener costo/);
    assert.match(texto, /2 producto\(s\) quedaron afuera porque ninguna de sus/);
    assert.match(texto, /55 productos publicados evaluados/);
    // La referencia de la cuenta, que es con lo que se estima si el clic se paga.
    assert.match(texto, /traer una venta cuesta/);
  } finally { await crm.cerrar(); }
});

test('sin el snapshot histórico la sección avisa qué migración falta', async () => {
  const estado = estadoConAds();
  estado.adsReco = {
    ...estado.adsReco,
    resumen: { ...estado.adsReco.resumen, snapshot_historico: false },
  };
  const crm = await irAAds(estado);
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /El histórico guardado no está disponible/);
    assert.match(texto, /20261001000000_add_ads_anuncios\.sql/);
    // Y por qué importa: sin snapshot, un producto apagado hace meses parece virgen.
    assert.match(texto, /nunca se hubiera anunciado/);
  } finally { await crm.cerrar(); }
});

test('una campaña que no se pudo leer entera se avisa antes que mostrar una lista incompleta', async () => {
  const estado = estadoConAds();
  estado.adsReco = {
    ...estado.adsReco,
    resumen: {
      ...estado.adsReco.resumen,
      incompleto: [{ campana: 'Campaña principal', motivo: 'tiene más de 600 anuncios' }],
    },
  };
  const crm = await irAAds(estado);
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /No se pudieron leer enteras 1 campaña/);
    assert.match(texto, /puede figurar como "sin anunciar" estando anunciado/);
  } finally { await crm.cerrar(); }
});

test('sin perfil de anunciante la sección lo dice en vez de mostrar una lista vacía', async () => {
  // La sección necesita saber qué está anunciado para poder decir qué falta anunciar.
  // Sin acceso a Ads no puede distinguirlo, y una lista vacía se leería como "está todo
  // cubierto", que es lo contrario de lo que pasa.
  const estado = estadoConAds();
  estado.adsReco = { ok: false, sin_acceso: true, mensaje: 'No se encontró perfil de anunciante en MELI Ads.' };
  const crm = await irAAds(estado);
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /No se encontró perfil de anunciante/);
    const chips = await crm.page.textContent('#ads-reco-chips');
    assert.strictEqual(chips.trim(), '', 'no debería haber chips sin datos');
  } finally { await crm.cerrar(); }
});

test('un anuncio que corre ahora no se cuenta en pasado', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');

    // El manillar se está anunciando en este momento: su acumulado no puede leerse como
    // el epitafio de un anuncio apagado.
    assert.match(texto, /Manillar Universal Aluminio/);
    assert.match(texto, /viene pagando/);
    assert.match(texto, /Acumulado/);

    // Y el que sí está apagado conserva el pasado, que ahí es lo correcto.
    assert.match(texto, /cuando se anunciaba, perdía/);
  } finally { await crm.cerrar(); }
});

test('un anuncio compartido entre variantes avisa que el número es su parte', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');
    // Sin esto, los $334 se leen como el gasto del anuncio y no cierran contra el panel
    // de MELI, que muestra los $1.002 del grupo entero.
    assert.match(texto, /comparte con 2 más/);

    // El que tiene el anuncio para él solo no arrastra el aviso.
    const sinAviso = await crm.page.$$eval('#ads-reco-lista > div > div', els =>
      els.filter(e => /Porta Matricula|Baúl Trasero/.test(e.textContent))
         .every(e => !/comparte con/.test(e.textContent)));
    assert.ok(sinAviso, 'el aviso de compartido se filtró a un anuncio propio');
  } finally { await crm.cerrar(); }
});

test('se pueden esconder los que vienen pagando, para trabajar sobre el resto', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-chips button', { timeout: 15000 });

    // El botón dice cuántos esconde antes de tocarlo.
    const boton = await crm.page.textContent('#ads-reco-chips button:has-text("Ocultar los que vienen pagando")');
    assert.match(boton, /· 1/);

    await crm.page.click('#ads-reco-chips button:has-text("Ocultar los que vienen pagando")');
    await crm.page.waitForTimeout(200);
    let texto = await crm.page.textContent('#ads-reco-lista');

    // El manillar viene pagando: se va. Lo demás, que sí pide acción, se queda.
    assert.ok(!/Manillar Universal Aluminio/.test(texto), 'no escondió el que viene pagando');
    assert.match(texto, /Baúl Trasero Moto 28L/);      // anunciado pero sin stock: hay que pausarlo
    assert.match(texto, /Espejos Moto Tipo Aleron/);   // sin anunciar: hay que prenderlo

    // Y lo dice, para que no parezca que se perdieron solos.
    assert.match(texto, /1 escondido por venir pagando/);

    // Vuelve a mostrarlos.
    await crm.page.click('#ads-reco-chips button:has-text("Ocultar los que vienen pagando")');
    await crm.page.waitForTimeout(200);
    texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /Manillar Universal Aluminio/);
  } finally { await crm.cerrar(); }
});

test('esconder los que pagan se combina con el filtro por motivo, sin mentir el vacío', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-chips button', { timeout: 15000 });
    await crm.page.click('#ads-reco-chips button:has-text("Ocultar los que vienen pagando")');
    await crm.page.waitForTimeout(200);
    // El único "Para escalar" del tablero es el que viene pagando: el motivo queda vacío,
    // y un "no hay nada" a secas haría pensar que no hay nada que escalar.
    await crm.page.click('#ads-reco-chips button:has-text("Para escalar")');
    await crm.page.waitForTimeout(200);
    const texto = await crm.page.textContent('#ads-reco-lista');
    assert.match(texto, /viene pagando \(1\)/);
    assert.match(texto, /No hay nada que tocar/);
  } finally { await crm.cerrar(); }
});

test('con dos campañas corriendo se pueden mirar juntas', async () => {
  const estado = estadoConAds();
  const crm = await irAAds(estado);
  try {
    // La opción aparece sola cuando hay más de una campaña gastando, y va primera: con
    // dos campañas el ROAS de equilibrio que importa es el del conjunto.
    const opciones = await crm.page.$$eval('#ads-campana option', els => els.map(e => ({ v: e.value, t: e.textContent })));
    assert.strictEqual(opciones[0].v, 'todas', `opciones: ${JSON.stringify(opciones)}`);
    assert.match(opciones[0].t, /Todas las campañas/);

    // Y el request la pide como tal.
    const pedidos = (estado.adsRequests || []).filter(u => u.startsWith('/meli/ads-anuncios'));
    assert.ok(pedidos.some(u => /campaign_id=todas/.test(u)), `pedidos: ${pedidos.join(' | ')}`);
  } finally { await crm.cerrar(); }
});

test('mirando todas, cada anuncio dice de qué campaña es y el total se desglosa', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    // Sin el desglose, un total de $16.383 no dice cuál de las dos lo está gastando.
    const aviso = await crm.page.textContent('#ads-aviso');
    assert.match(aviso, /Mirando 2 campañas juntas/);
    assert.match(aviso, /TEST - muchos ads/);
    assert.match(aviso, /WINNERS/);

    // Y cada fila se puede volver a atribuir a su campaña.
    const tabla = await crm.page.textContent('#ads-tabla');
    assert.match(tabla, /TEST - muchos ads/);
    assert.match(tabla, /WINNERS/);
  } finally { await crm.cerrar(); }
});

test('un producto corriendo en las dos campañas sale marcado', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    const texto = await crm.page.textContent('#ads-reco-lista');

    // Armar una campaña de winners a partir de otra deja los winners en las dos, y ahí
    // son dos anuncios tuyos compitiendo en la misma subasta.
    assert.match(texto, /Espejos Aleron Chico/);
    assert.match(texto, /Dejarlo en una sola/);
    assert.match(texto, /2 campañas a la vez/);
    assert.match(texto, /misma subasta/);

    // Y en la ficha se ve en cuáles, sin tener que abrir MELI.
    assert.match(texto, /en TEST - muchos ads \+ WINNERS/);
  } finally { await crm.cerrar(); }
});

test('no hubo errores ni alertas en la pestaña de Ads', async () => {
  const crm = await irAAds(estadoConAds());
  try {
    await crm.page.waitForSelector('#ads-reco-lista', { timeout: 15000 });
    await crm.page.click('#ads-reco-chips button:has-text("Lo que falta anunciar")');
    await crm.page.waitForTimeout(200);
    await crm.page.click('#ads-reco-chips button:has-text("Todo")');
    await crm.page.waitForTimeout(200);
    assert.deepStrictEqual(erroresReales(crm.errores), []);
    assert.deepStrictEqual(crm.alertas, []);
  } finally { await crm.cerrar(); }
});
