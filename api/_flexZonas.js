// api/_flexZonas.js
// Detecta la zona Flex y calcula costos de EnviosUy y GestionPost
// basándose en la dirección de entrega de la orden MELI

// =====================
// TABLA DE COSTOS
// =====================
const COSTOS = {
  gestionpost: {
    1: 169, 2: 169, 3: 169, 4: 169, 5: 169, 6: 169,
    7: 139,
    8: 200, 9: 200, 10: 200, 11: 200,
    retiro: 75, // costo fijo por retiro
  },
  enviosuy: {
    1: 190, 2: 190, 3: 190, 4: 190,
    5: 180, 7: 180,
    6: 160,
    8: 240, 9: 240,
    10: 200,
    11: null, // No realizan envíos a zona 11
  },
};

// =====================
// MAPEO DE BARRIOS/ZONAS
// Basado en el mapa de zonas Flex de Montevideo
// =====================
const ZONAS_KEYWORDS = {
  // Zona 1 — Oeste (Pajas Blancas, Santiago Vázquez, Paso de la Arena)
  1: ['pajas blancas', 'santiago vazquez', 'santiago vázquez', 'paso de la arena', 'ciudad del plata'],

  // Zona 2 — Centro-Oeste (La Paz, Colón, Lezica)
  2: ['la paz', 'colon', 'colón', 'lezica', 'abayuba', 'jardines del hipodromo', 'jardines del hipódromo'],

  // Zona 3 — Centro (Toledo, Manga, Piedras Blancas)
  3: ['toledo', 'manga', 'piedras blancas', 'flor de maronas', 'maronas', 'ituzaingo', 'ituzaingó'],

  // Zona 4 — Centro-Este (Barros Blancos sur, Pueblo Nuevo)
  4: ['barros blancos', 'pueblo nuevo', 'bolivar', 'bolívar', 'las canteras'],

  // Zona 5 — Sur-Centro (Pocitos, Buceo, Malvín, Punta Carretas)
  5: ['pocitos', 'buceo', 'malvin', 'malvín', 'punta carretas', 'parque rodo', 'parque rodó', 'palermo', 'cordon', 'cordón', 'tres cruces', 'villa española', 'villa espanola', 'unión', 'union'],

  // Zona 6 — Sur (Punta Gorda, Carrasco, Shangrilá)
  6: ['punta gorda', 'carrasco', 'shangrila', 'shangrilá', 'neptunia', 'el pinar'],

  // Zona 7 — Centro (Ciudad Vieja, Centro, Goes, La Comercial, Aguada)
  7: ['ciudad vieja', 'centro', 'goes', 'la comercial', 'aguada', 'reducto', 'belvedere', 'la blanqueada', 'figurita', 'jacinto vera', 'sayago', 'nuevo paris', 'nuevo parís', 'cerro', 'la teja', 'paso molino', 'peñarol', 'penarol'],

  // Zona 8 — Norte (Progreso, Las Piedras, La Paz dpto Canelones)
  8: ['progreso', 'las piedras', 'sauce', 'empalme olmos', 'juanico', 'canelones'],

  // Zona 9 — Este (Pando, Toledo Este, Barros Blancos norte)
  9: ['pando', 'toledo este', 'lagomar', 'solymar', 'la floresta'],

  // Zona 10 — Ciudad de la Costa
  10: ['ciudad de la costa', 'atlantida', 'atlántida', 'parque del plata', 'salinas', 'la floresta', 'costa'],

  // Zona 11 — Canelones (ciudad)
  11: ['canelones ciudad', 'canelones capital', '14 de julio'],
};

/**
 * Detecta la zona Flex a partir de una dirección de texto
 * @param {string} direccion - Dirección completa de la orden MELI
 * @returns {number|null} - Número de zona (1-11) o null si no se detecta
 */
function detectarZona(direccion) {
  if (!direccion) return null;
  const dir = direccion.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes para comparación
    .toLowerCase();

  // Buscar coincidencia por keywords de cada zona
  for (const [zona, keywords] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (dir.includes(kwNorm)) {
        return parseInt(zona);
      }
    }
  }
  return null;
}

/**
 * Calcula el costo de envío para cada cadetería dado una zona
 * @param {number} zona - Número de zona (1-11)
 * @returns {object} - { zona, enviosuy, gestionpost, recomendada, costoRecomendado }
 */
function calcularCostos(zona) {
  if (!zona) return null;

  const costoEnviosUy = COSTOS.enviosuy[zona] ?? null;
  const costoGestionPost = COSTOS.gestionpost[zona] !== undefined
    ? COSTOS.gestionpost[zona] + COSTOS.gestionpost.retiro
    : null;

  // Lógica de recomendación:
  // - Si EnviosUy no cubre la zona → GestionPost
  // - Si ambas cubren → EnviosUy por defecto (es la preferida)
  let recomendada, costoRecomendado;

  if (costoEnviosUy === null) {
    recomendada = 'gestionpost';
    costoRecomendado = costoGestionPost;
  } else {
    recomendada = 'enviosuy';
    costoRecomendado = costoEnviosUy;
  }

  return {
    zona,
    enviosuy: costoEnviosUy,
    gestionpost: costoGestionPost,
    recomendada,
    costoRecomendado,
  };
}

/**
 * Función principal: dado una dirección, retorna zona + costos
 * @param {string} direccion
 * @returns {object|null}
 */
function calcularCostoFlex(direccion) {
  const zona = detectarZona(direccion);
  if (!zona) return null;
  return calcularCostos(zona);
}

module.exports = { detectarZona, calcularCostos, calcularCostoFlex, COSTOS, ZONAS_KEYWORDS };
