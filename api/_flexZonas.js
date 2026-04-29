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
  // Zona 1 — Cerro, Casabó, Pajas Blancas, Santiago Vázquez, Nuevo París, etc.
  1: ['villa del cerro', 'punta espinillo', 'santiago vazquez', 'tres ombues', 'paso de la arena', 'pajas blancas', 'nuevo paris', 'la paloma', 'victoria', 'casabo', 'cerro'],

  // Zona 2 — Colón, Lezica, Melilla, Abayubá
  2: ['cuchilla pereira', 'conciliacion', 'abayuba', 'melilla', 'lezica', 'colon'],

  // Zona 3 — Manga, Toledo Chico, Villa García
  3: ['toledo chico', 'villa garcia', 'manga'],

  // Zona 4 — Bañados de Carrasco, Bella Italia, Chacarita, Punta Rieles
  4: ['banados de carrasco', 'bella italia', 'chacarita', 'punta rieles'],

  // Zona 5 — Buceo, Carrasco, Malvín, Punta Gorda, Maroñas, Unión, etc.
  5: ['flor de maronas', 'carrasco norte', 'malvin norte', 'puerto buceo', 'pocitos nuevo', 'playa verde', 'las canteras', 'punta gorda', 'maronas', 'carrasco', 'buceo', 'malvin', 'union'],

  // Zona 6 — Centro, Pocitos, Cordón, Palermo, Jacinto Vera, Reducto, etc.
  6: ['ciudad vieja', 'parque batlle', 'villa biarritz', 'villa dolores', 'la blanqueada', 'punta carretas', 'la comercial', 'parque rodo', 'barrio sur', 'villa munoz', 'tres cruces', 'jacinto vera', 'larranaga', 'figurita', 'reducto', 'palermo', 'aguada', 'pocitos', 'cordon', 'centro', 'goes'],

  // Zona 7 — Belvedere, Peñarol, Sayago, Casavalle, Prado, Villa Española, etc.
  7: ['cementerio del norte', 'paso de las duranas', 'jardines hipodromo', 'piedras blancas', 'villa espanola', 'brazo oriental', 'bella vista', 'arroyo seco', 'aires puros', 'castro perez', 'castellanos', 'paso molino', 'las acacias', 'ituzaingo', 'atahualpa', 'casavalle', 'belvedere', 'lavalleja', 'capurro', 'cerrito', 'marconi', 'bolivar', 'la teja', 'sayago', 'penarol', 'prado'],

  // Zona 8 — La Paz, Las Piedras, Progreso
  8: ['las piedras', 'progreso', 'la paz'],

  // Zona 9 — Pando, Barros Blancos, Toledo, Cumbres de Carrasco, etc.
  9: ['cumbres de carrasco', 'rincon de carrasco', 'joaquin suarez', 'barros blancos', 'casarino', 'toledo', 'suarez', 'pando'],

  // Zona 10 — Ciudad de la Costa, Solymar, Shangrilá, El Pinar, Lagomar, etc.
  10: ['ciudad de la costa', 'colinas de carrasco', 'colinas de solymar', 'medanos de solymar', 'montes de solymar', 'san jose de carrasco', 'lomas de carrasco', 'barra de carrasco', 'parque de solymar', 'lomas de solymar', 'paso de carrasco', 'pinares de solymar', 'villa aeroparque', 'empalme nicolich', 'parque miramar', 'parque carrasco', 'la tahona', 'el dorado', 'el bosque', 'el pinar', 'shangrila', 'lagomar', 'solymar'],

  // Zona 11 — Canelones (ciudad)
  11: ['canelones ciudad', 'canelones capital'],
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
    .replace(/[̀-ͯ]/g, '');

  // Ordenar de mayor a menor longitud: keywords mas especificos ganan sobre los mas cortos
  const allKeywords = [];
  for (const [zona, keywords] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      allKeywords.push([kwNorm, parseInt(zona)]);
    }
  }
  allKeywords.sort((a, b) => b[0].length - a[0].length);

  for (const [kw, zona] of allKeywords) {
    if (dir.includes(kw)) return zona;
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

  // Recomendación base: EnviosUy si cubre, sino GestionPost
  const recomendada = costoEnviosUy === null ? 'gestionpost' : 'enviosuy';
  const costoRecomendado = recomendada === 'enviosuy' ? costoEnviosUy : costoGestionPost;

  return {
    zona,
    enviosuy: costoEnviosUy,
    gestionpost: costoGestionPost,
    recomendada,
    costoRecomendado,
  };
}

// =====================
// SELECCIÓN POR HORARIO (MONTEVIDEO)
// =====================

/**
 * Devuelve hora, minuto y día de semana en timezone America/Montevideo
 * @param {Date|string} fecha
 * @returns {{ hora: number, minuto: number, weekday: string }}
 */
function getTimeMVD(fecha) {
  const date = fecha instanceof Date ? fecha : new Date(fecha);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Montevideo',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    hora: parseInt(map.hour),
    minuto: parseInt(map.minute || '0'),
    weekday: map.weekday, // 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'
  };
}

/**
 * Selecciona transportista para envíos Flex según zona y horario de la compra (MVD)
 *
 * Zona 11 → siempre GestionPost (EnviosUy no cubre en Flex)
 * Lun-Vie: <15hs o >16hs → EnviosUy; 15-16hs → GestionPost
 * Sáb: <12hs o ≥13hs → EnviosUy; 12-13hs → GestionPost
 * Dom: siempre EnviosUy (se despacha el lunes)
 *
 * @param {number} zona
 * @param {Date|string} [fecha] - Fecha/hora de la compra (default: ahora)
 * @returns {'enviosuy'|'gestionpost'}
 */
function seleccionarTransportista(zona, fecha) {
  if (zona === 11) return 'gestionpost';

  const { hora, minuto, weekday } = getTimeMVD(fecha || new Date());
  const hm = hora * 60 + minuto;

  if (weekday === 'Sun') return 'enviosuy';

  if (weekday === 'Sat') {
    if (hm < 12 * 60) return 'enviosuy';
    if (hm < 13 * 60) return 'gestionpost';
    return 'enviosuy';
  }

  // Lunes a Viernes
  if (hm < 15 * 60) return 'enviosuy';
  if (hm < 16 * 60) return 'gestionpost';
  return 'enviosuy';
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

/**
 * Calcula zona + costos seleccionando transportista según horario de la compra
 * @param {string} direccion
 * @param {Date|string} [fecha] - Fecha de la compra (default: ahora)
 * @returns {object|null}
 */
function calcularCostoFlexConHorario(direccion, fecha) {
  const zona = detectarZona(direccion);
  if (!zona) return null;
  const costos = calcularCostos(zona);
  if (!costos) return null;

  const recomendada = seleccionarTransportista(zona, fecha || new Date());
  const costoRecomendado = recomendada === 'enviosuy' ? costos.enviosuy : costos.gestionpost;

  return { ...costos, recomendada, costoRecomendado };
}

module.exports = { detectarZona, calcularCostos, calcularCostoFlex, calcularCostoFlexConHorario, seleccionarTransportista, COSTOS, ZONAS_KEYWORDS };
