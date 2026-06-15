// api/_flexZonas.js
// Detecta zona Flex y calcula costo para EnviosUy.
// Todo envío Flex va por EnviosUy. Si hay excepción, el usuario la corrige manualmente.

const COSTOS_ENVIOSUY = {
  1: 190, 2: 190, 3: 190, 4: 190,
  5: 180, 7: 180,
  6: 160,
  8: 240, 9: 240,
  10: 200,
  11: null, // cobertura especial — corregir manualmente si aplica
};

const ZONAS_KEYWORDS = {
  1: ['villa del cerro', 'punta espinillo', 'santiago vazquez', 'tres ombues', 'paso de la arena', 'pajas blancas', 'nuevo paris', 'la paloma', 'victoria', 'casabo', 'cerro'],
  2: ['cuchilla pereira', 'conciliacion', 'abayuba', 'melilla', 'lezica', 'colon'],
  3: ['toledo chico', 'villa garcia', 'manga'],
  4: ['banados de carrasco', 'bella italia', 'chacarita', 'punta rieles'],
  5: ['flor de maronas', 'carrasco norte', 'malvin norte', 'puerto buceo', 'pocitos nuevo', 'playa verde', 'las canteras', 'punta gorda', 'maronas', 'carrasco', 'buceo', 'malvin', 'union'],
  6: ['ciudad vieja', 'parque batlle', 'villa biarritz', 'villa dolores', 'la blanqueada', 'punta carretas', 'la comercial', 'parque rodo', 'barrio sur', 'villa munoz', 'tres cruces', 'jacinto vera', 'larranaga', 'figurita', 'reducto', 'palermo', 'aguada', 'pocitos', 'cordon', 'centro', 'goes'],
  7: ['cementerio del norte', 'paso de las duranas', 'jardines hipodromo', 'piedras blancas', 'villa espanola', 'brazo oriental', 'bella vista', 'arroyo seco', 'aires puros', 'castro perez', 'castellanos', 'paso molino', 'las acacias', 'ituzaingo', 'atahualpa', 'casavalle', 'belvedere', 'lavalleja', 'capurro', 'cerrito', 'marconi', 'bolivar', 'la teja', 'sayago', 'penarol', 'prado'],
  8: ['las piedras', 'progreso', 'la paz'],
  9: ['cumbres de carrasco', 'rincon de carrasco', 'joaquin suarez', 'barros blancos', 'casarino', 'toledo', 'suarez', 'pando'],
  10: ['ciudad de la costa', 'colinas de carrasco', 'colinas de solymar', 'medanos de solymar', 'montes de solymar', 'san jose de carrasco', 'lomas de carrasco', 'barra de carrasco', 'parque de solymar', 'lomas de solymar', 'paso de carrasco', 'pinares de solymar', 'villa aeroparque', 'empalme nicolich', 'parque miramar', 'parque carrasco', 'la tahona', 'el dorado', 'el bosque', 'el pinar', 'shangrila', 'lagomar', 'solymar'],
  11: ['canelones ciudad', 'canelones capital'],
};

function normalizarTexto(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Detecta zona a partir de cualquier texto (barrio, ciudad, dirección)
function detectarZona(texto) {
  if (!texto) return null;
  const t = normalizarTexto(texto);

  const allKeywords = [];
  for (const [zona, keywords] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of keywords) {
      allKeywords.push([normalizarTexto(kw), parseInt(zona)]);
    }
  }
  // keywords más largos primero para mayor precisión
  allKeywords.sort((a, b) => b[0].length - a[0].length);

  for (const [kw, zona] of allKeywords) {
    if (t.includes(kw)) return zona;
  }
  return null;
}

/**
 * Detecta zona usando datos del envío MELI, priorizando campos estructurados.
 * 1. route.name si MELI expone zona directamente ("Zona 5", "Z5")
 * 2. receiver_address.neighborhood.name (barrio estructurado de MELI — no especulación)
 * 3. Dirección completa como fallback
 */
function detectarZonaDesdeShipData(shipData) {
  if (!shipData) return null;

  // 1. Nombre de ruta de MELI
  const routeName = shipData?.route?.name || '';
  if (routeName) {
    const m = routeName.match(/zona\s*(\d+)/i) || routeName.match(/^z(\d+)$/i);
    if (m) return parseInt(m[1]);
  }

  const addr = shipData?.receiver_address;
  if (!addr) return null;

  // 2. Barrio desde campo estructurado de MELI
  const neighborhood = addr.neighborhood?.name || '';
  if (neighborhood) {
    const zona = detectarZona(neighborhood);
    if (zona) return zona;
  }

  // 3. Dirección completa como último recurso
  const partes = [addr.street_name, addr.street_number, neighborhood, addr.city?.name, addr.state?.name]
    .filter(Boolean).join(', ');
  return detectarZona(partes);
}

/**
 * Calcula zona y costo Flex para EnviosUy usando datos del shipment MELI
 */
function calcularCostoFlexDesdeShipData(shipData) {
  const zona = detectarZonaDesdeShipData(shipData);
  const costo = zona ? (COSTOS_ENVIOSUY[zona] ?? 0) : 0;
  return { zona, transportista: 'enviosuy', costo };
}

// Backward-compat: calcula desde string de dirección
function calcularCostoFlex(direccion) {
  const zona = detectarZona(direccion);
  if (!zona) return null;
  return { zona, transportista: 'enviosuy', costo: COSTOS_ENVIOSUY[zona] ?? 0 };
}

module.exports = {
  detectarZona,
  detectarZonaDesdeShipData,
  calcularCostoFlexDesdeShipData,
  calcularCostoFlex,
  COSTOS_ENVIOSUY,
  ZONAS_KEYWORDS,
};
