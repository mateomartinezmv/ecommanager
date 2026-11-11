// api/meli/_conversion.js
// La tasa de conversión de cada producto en MELI, sin tocar MELI ni Supabase.
//
// Conversión = unidades vendidas en MELI / visitas, en el mismo período. Un producto se
// publica varias veces (la original y los ángulos): visitas y ventas se suman entre todas sus
// publicaciones, porque es el mismo producto el que se compra.
//
// El orden es de menor a mayor conversión, que es lo que hay que mirar primero: las que la
// gente ve y no compra. Las que no tuvieron visitas no tienen conversión (no es 0%: nadie las
// vio) y van al final, aparte, para no mezclar "no convence" con "no aparece".

const { meliIdsDe } = require('../_meliIds');

// Debajo de esta cantidad de visitas el porcentaje es ruido: 1 venta en 5 visitas no es un 20%.
const VISITAS_MINIMAS = 30;

function armarFilas({ productos, visitasPorItem, ventas, skusConFotos }) {
  const unidades = {};
  for (const v of ventas || []) {
    if (v.canal !== 'meli' || v.estado === 'cancelada') continue;
    unidades[v.sku] = (unidades[v.sku] || 0) + (Number(v.cantidad) || 0);
  }
  const conFotos = new Set(skusConFotos || []);

  const filas = (productos || [])
    .filter(p => !p.discontinuado && meliIdsDe(p).length)
    .map(p => {
      const ids = meliIdsDe(p);
      const leidas = ids.filter(id => visitasPorItem[id] != null);
      const visitas = leidas.reduce((s, id) => s + Number(visitasPorItem[id] || 0), 0);
      const vendidas = unidades[p.sku] || 0;
      return {
        sku: p.sku,
        nombre: p.nombre,
        grupo: p.grupo || null,
        subgrupo: p.subgrupo || null,
        publicaciones: ids.length,
        // Si MELI no devolvió las visitas de ninguna publicación, no se sabe: no es 0.
        visitas: leidas.length ? visitas : null,
        vendidas,
        conversion: leidas.length && visitas > 0 ? vendidas / visitas : null,
        pocas_visitas: leidas.length > 0 && visitas < VISITAS_MINIMAS,
        fotos_nuevas: conFotos.has(p.sku),
      };
    });

  // De menor a mayor conversión; empate: la de más visitas primero (más gente que no compró).
  // Sin conversión (sin visitas o sin dato), al final.
  return filas.sort((a, b) => {
    if (a.conversion == null && b.conversion == null) return (b.visitas || 0) - (a.visitas || 0);
    if (a.conversion == null) return 1;
    if (b.conversion == null) return -1;
    return a.conversion - b.conversion || (b.visitas || 0) - (a.visitas || 0);
  });
}

// "YYYY-MM-DD" de hace `dias` días y de hoy, en UTC (lo que pide MELI).
function rango(dias, hoy = new Date()) {
  const hasta = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()));
  const desde = new Date(hasta.getTime() - dias * 86400000);
  const f = d => d.toISOString().slice(0, 10);
  return { desde: f(desde), hasta: f(hasta) };
}

module.exports = { armarFilas, rango, VISITAS_MINIMAS };
