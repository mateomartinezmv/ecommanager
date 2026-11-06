// api/whatsapp/setup.js
// GET  /api/whatsapp/setup                    → qué variables de Kapso están cargadas (sin mostrar secretos)
// POST /api/whatsapp/setup?accion=plantilla   → crea en Meta la plantilla para avisos fuera de la ventana de 24 h
// POST /api/whatsapp/setup?accion=prueba      → manda un aviso de prueba a WHATSAPP_TO
//
// Orden de puesta en marcha: verificar el número del negocio en Kapso, cargar las env vars,
// redeploy, crear la plantilla, escribirle "hola" al número del negocio desde tu WhatsApp
// personal (abre la ventana de 24 h) y mandar la prueba.

const { enviarWhatsapp, PLANTILLA_POR_DEFECTO, KAPSO_BASE } = require('../_aviso');

const VARIABLES = ['KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID', 'KAPSO_WABA_ID', 'WHATSAPP_TO', 'KAPSO_TEMPLATE_NAME'];

function estado() {
  const cargadas = Object.fromEntries(VARIABLES.map(v => [v, !!process.env[v]]));
  const to = process.env.WHATSAPP_TO || '';
  return {
    variables: cargadas,
    // Sólo los últimos 3 dígitos: alcanza para ver que es el número correcto.
    whatsapp_to: to ? `…${to.slice(-3)}` : null,
    whatsapp_to_formato_ok: !to || /^\d{10,15}$/.test(to),
    listo_para_enviar: cargadas.KAPSO_API_KEY && cargadas.KAPSO_PHONE_NUMBER_ID && cargadas.WHATSAPP_TO,
  };
}

async function crearPlantilla() {
  const { KAPSO_API_KEY, KAPSO_WABA_ID } = process.env;
  if (!KAPSO_API_KEY || !KAPSO_WABA_ID) {
    return { ok: false, error: 'Faltan KAPSO_API_KEY y/o KAPSO_WABA_ID' };
  }
  const nombre = process.env.KAPSO_TEMPLATE_NAME || PLANTILLA_POR_DEFECTO;
  const res = await fetch(`${KAPSO_BASE}/${KAPSO_WABA_ID}/message_templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KAPSO_API_KEY },
    body: JSON.stringify({
      name: nombre,
      category: 'UTILITY',
      language: process.env.KAPSO_TEMPLATE_LANG || 'es',
      components: [{
        type: 'BODY',
        text: 'Aviso de EcomManager: {{1}}',
        example: { body_text: [['Publicación pausada en MELI · Producto: Espejo moto · Motivo: sin stock disponible']] },
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, plantilla: nombre, respuesta: body };
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.json({ ok: true, ...estado() });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Usá GET o POST' });

  const accion = req.query?.accion;
  try {
    if (accion === 'plantilla') return res.json(await crearPlantilla());
    if (accion === 'prueba') {
      const enviado = await enviarWhatsapp(
        '✅ <b>WhatsApp configurado</b>\n\nEcomManager te va a avisar por acá de ventas sin registrar, ' +
        'publicaciones pausadas, el resumen diario y correcciones de stock.'
      );
      return res.json({ ok: enviado, ...estado(), ...(enviado ? {} : { ayuda: 'Mirá los logs de Vercel (Kapso HTTP …)' }) });
    }
    return res.status(400).json({ ok: false, error: 'accion debe ser "plantilla" o "prueba"' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
