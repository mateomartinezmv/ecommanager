// api/_flexZonas.js
// Detecta la zona de un envío Flex y calcula lo que cobra el transportista.
//
// Todo envío Flex sale por GestionPost salvo que se cambie a mano. Las zonas son las de
// ZONAS_KEYWORDS (las mismas para todos los transportistas); lo que cambia es la tarifa.

// El transportista que se propone para un envío Flex, en el webhook y en los formularios.
const TRANSPORTISTA_FLEX = 'gestionpost';

// Los que hacen Flex en Montevideo con un transportista propio (el resto es Mercado Envíos,
// interior u otro). Un envío que ya va por uno de estos no se cambia al reprocesar.
const TRANSPORTISTAS_FLEX = ['gestionpost', 'enviosuy', 'mmotos_mateo'];

// Tarifa de GestionPost por zona, sacada de sus envíos reales (sep-nov 2026) y confirmada
// con lo que cobraron.
const COSTOS_GESTIONPOST = {
  1: 200, 2: 200, 3: 200, 4: 200,
  5: 169, 6: 169, 7: 169,
  8: 290, 9: 290,
  10: 200,
  11: 290,
};

// Localidades que GestionPost cobra distinto que el resto de su zona. Se comparan contra
// el barrio o la ciudad del envío, nunca contra la calle: "esq. El Dorado" en el
// Aeropuerto es zona 10 común ($200).
const EXCEPCIONES_GESTIONPOST = [
  { localidad: 'el dorado', costo: 290 }, // zona 10, pero sale como zona 8/9
];

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

// Además de bajar a minúsculas y sacar tildes, saca los "de/del" sueltos: la misma zona
// se escribe "Punta de Rieles" o "Punta Rieles" según quién la tipee. Como se aplica igual
// al texto y a la keyword, la comparación queda pareja.
function normalizarTexto(t) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(de|del)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// La excepción de GestionPost que aplica a la dirección, si hay. La dirección tiene la
// forma "calle, número, barrio, ciudad, departamento" (la arma el webhook de MELI) o
// "calle 1234, barrio" (la cargada a mano): el primer tramo es la calle y no cuenta. Si
// hay un solo tramo es el barrio elegido del catálogo ("El Dorado") y ése sí cuenta.
function excepcionGestionPost(direccion) {
  const todos = String(direccion || '').split(',').map(normalizarTexto).filter(Boolean);
  const tramos = todos.length > 1 ? todos.slice(1) : todos;
  return EXCEPCIONES_GESTIONPOST.find(ex => tramos.includes(normalizarTexto(ex.localidad))) || null;
}

/**
 * Lo que cobra el transportista por un envío Flex a esa zona. null si no tiene tarifa
 * fija (EnviosUy en zona 11) o si el transportista no tiene tabla: se carga a mano.
 */
function costoFlex(transportista, zona, direccion) {
  if (!zona) return null;
  if (transportista === 'gestionpost') {
    const ex = excepcionGestionPost(direccion);
    if (ex) return ex.costo;
    return COSTOS_GESTIONPOST[zona] ?? null;
  }
  if (transportista === 'enviosuy') return COSTOS_ENVIOSUY[zona] ?? null;
  return null;
}

/**
 * Calcula zona y costo Flex usando datos del shipment MELI, con el transportista por defecto.
 */
function calcularCostoFlexDesdeShipData(shipData, direccion) {
  const zona = detectarZonaDesdeShipData(shipData);
  const costo = costoFlex(TRANSPORTISTA_FLEX, zona, direccion) ?? 0;
  return { zona, transportista: TRANSPORTISTA_FLEX, costo };
}

// Backward-compat: calcula desde string de dirección
function calcularCostoFlex(direccion) {
  const zona = detectarZona(direccion);
  if (!zona) return null;
  return { zona, transportista: TRANSPORTISTA_FLEX, costo: costoFlex(TRANSPORTISTA_FLEX, zona, direccion) ?? 0 };
}

module.exports = {
  detectarZona,
  detectarZonaDesdeShipData,
  calcularCostoFlexDesdeShipData,
  calcularCostoFlex,
  costoFlex,
  excepcionGestionPost,
  TRANSPORTISTA_FLEX,
  TRANSPORTISTAS_FLEX,
  COSTOS_GESTIONPOST,
  EXCEPCIONES_GESTIONPOST,
  COSTOS_ENVIOSUY,
  ZONAS_KEYWORDS,
};
