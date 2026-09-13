// api/direcciones.js
// Autocompletado de direcciones + detección de zona para los envíos que se cargan a mano
// (típicamente ventas mostrador: en los Flex de MELI la zona ya viene del shipment).
//
// GET /api/direcciones?catalogo=1 → barrios/localidades con su zona y costo (para buscar
//                                   sin red desde el navegador)
// GET /api/direcciones?q=texto    → sugerencias de dirección real (OpenStreetMap/Nominatim)
//                                   ya resueltas a zona y costo EnviosUy

const { detectarZona, COSTOS_ENVIOSUY, ZONAS_KEYWORDS } = require('./_flexZonas');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Nominatim exige identificar la aplicación y pide como mucho 1 consulta por segundo.
const USER_AGENT = 'EcomManager/1.0 (CRM de envíos; https://github.com/mateomartinezmv/ecommanager)';
const TIMEOUT_MS = 6000;

// Cache en memoria de la lambda: las mismas direcciones se tipean una y otra vez.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;

function costoDeZona(zona) {
  if (!zona) return null;
  const costo = COSTOS_ENVIOSUY[zona];
  return costo === undefined ? null : costo;
}

function titulo(t) {
  return t.replace(/\b([a-záéíóúñ])/g, (m) => m.toUpperCase());
}

// Barrios y localidades conocidos, ordenados por nombre. El front los usa para sugerir
// y detectar zona al instante, sin depender de la red.
function catalogo() {
  const items = [];
  for (const [zona, keywords] of Object.entries(ZONAS_KEYWORDS)) {
    for (const kw of keywords) {
      items.push({ nombre: titulo(kw), zona: parseInt(zona), costo: costoDeZona(parseInt(zona)) });
    }
  }
  items.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return items;
}

// Arma una dirección corta y legible desde los campos estructurados de Nominatim.
// La zona se busca primero en el barrio (lo más preciso) y recién después en la ciudad:
// muchas calles se llaman igual que un barrio y ahí la detección por texto libre falla.
function aSugerencia(item) {
  const a = item.address || {};
  const calle = a.road || a.pedestrian || a.footway || a.residential || '';
  const numero = a.house_number || '';
  const barrio = a.neighbourhood || a.suburb || a.quarter || a.city_district || a.hamlet || '';
  const ciudad = a.city || a.town || a.village || a.municipality || '';
  const resto = [barrio, ciudad].filter(Boolean);
  // `direccion` es la que se muestra en el listado (con puerta, para reconocerla) y
  // `direccionBase` la misma sin el número, porque en el formulario la puerta va aparte.
  const direccion = [[calle, numero].filter(Boolean).join(' '), ...resto].filter(Boolean).join(', ') || item.display_name;
  const direccionBase = [calle, ...resto].filter(Boolean).join(', ') || item.display_name;
  const zona = detectarZona(barrio) || detectarZona(ciudad) || detectarZona(item.display_name);
  return {
    direccion,
    direccionBase,
    numero: numero || null,
    barrio: barrio || null,
    ciudad: ciudad || null,
    zona: zona || null,
    costo: costoDeZona(zona),
    fuente: 'osm',
  };
}

async function buscarEnNominatim(q) {
  const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&countrycodes=uy&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  const vistas = new Set();
  const sugerencias = [];
  for (const item of data) {
    const s = aSugerencia(item);
    const clave = s.direccion.toLowerCase();
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    sugerencias.push(s);
  }
  return sugerencias;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (req.query.catalogo) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json({ costos: COSTOS_ENVIOSUY, localidades: catalogo() });
  }

  const q = (req.query.q || '').toString().trim();
  if (q.length < 3) return res.json({ sugerencias: [] });

  const clave = q.toLowerCase();
  const cacheado = cache.get(clave);
  if (cacheado && Date.now() - cacheado.at < CACHE_TTL_MS) {
    return res.json({ sugerencias: cacheado.sugerencias, cache: true });
  }

  try {
    const sugerencias = await buscarEnNominatim(q);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(clave, { at: Date.now(), sugerencias });
    return res.json({ sugerencias });
  } catch (err) {
    // El buscador de direcciones es una ayuda, no un requisito: si falla, el front sigue
    // andando con el catálogo local de barrios y con lo que se escriba a mano.
    console.warn('No se pudo consultar Nominatim:', err.message);
    return res.json({ sugerencias: [], error: err.message });
  }
};
