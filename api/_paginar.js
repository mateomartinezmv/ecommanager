// api/_paginar.js
// Supabase devuelve como mucho 1000 filas por consulta (el "max rows" de la API), aunque se
// pida .limit(50000): lo que pasa de ahí se pierde sin error. Tablas que ya lo pasan:
// meli_ads_anuncios (~1.100 filas por mes, una por anuncio por día) y, pronto, ventas.
//
// todasLasFilas pide de a páginas hasta que una viene incompleta. `armar` tiene que devolver
// una consulta NUEVA cada vez (con su select, filtros y un order estable), porque una
// consulta de supabase-js se consume al esperarla.

const PAGINA = 1000;

async function todasLasFilas(armar, { pagina = PAGINA, tope = 200 } = {}) {
  const filas = [];
  for (let i = 0; i < tope; i++) {
    const desde = i * pagina;
    const { data, error } = await armar().range(desde, desde + pagina - 1);
    if (error) return { data: filas.length ? filas : null, error };
    filas.push(...(data || []));
    if (!data || data.length < pagina) break;
  }
  return { data: filas, error: null };
}

module.exports = { todasLasFilas, PAGINA };
