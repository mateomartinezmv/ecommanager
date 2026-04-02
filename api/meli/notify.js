// api/meli/notify.js
// POST /api/meli/notify → recibe notificaciones de MELI (ventas, stock)
// GET  /api/meli/notify → diagnóstico de conexión MELI
//
// Arquitectura: responde 200 inmediatamente a MELI y delega el procesamiento
// a la Supabase Edge Function `procesar-orden-meli` (fire-and-forget).
// Esto evita que Vercel corte el trabajo async en el plan Hobby (límite 10s).

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleStatus(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topic, resource } = req.body || {};
  console.log('MELI notify:', topic, resource);

  const supabase = getSupabase();

  // 1. Audit log — guardar antes de responder para no perder la notificación
  try {
    await supabase.from('meli_notify_log').insert({
      topic: topic || null,
      resource: resource || null,
      recibido_at: new Date().toISOString(),
    });
  } catch (_) { /* no bloquear el flujo si falla el log */ }

  // 2. Responder 200 de inmediato (MELI espera < 5s o marca como fallido)
  res.status(200).json({ ok: true });

  // 3. Determinar el order_id a procesar
  let orderId = null;

  if (topic === 'orders_v2' || topic === 'orders') {
    orderId = (resource || '').replace('/orders/', '').split('/')[0];
  } else if (topic === 'payments') {
    // Para payments: resolver payment → order_id vía API MELI, luego despachar
    try {
      const token = await getMeliToken();
      const paymentId = (resource || '').replace('/collections/', '').split('/')[0];
      const payRes = await fetch(`https://api.mercadolibre.com/collections/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const pay = await payRes.json();
      if (pay.collection?.order_id) {
        orderId = String(pay.collection.order_id);
      }
    } catch (err) {
      console.error('Error resolviendo payment→order:', err.message);
    }
  }

  // 4. Fire-and-forget: invocar Supabase Edge Function para procesar la orden
  //    La Edge Function tiene su propio timeout (150s) y maneja toda la lógica.
  if (orderId) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (supabaseUrl && supabaseKey) {
      fetch(`${supabaseUrl}/functions/v1/procesar-orden-meli`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ orden_id: orderId }),
      }).then(r => {
        if (!r.ok) r.text().then(t => console.error(`procesar-orden-meli error ${r.status}:`, t));
        else console.log(`✅ procesar-orden-meli invocada para orden ${orderId}`);
      }).catch(err => console.error('Error invocando procesar-orden-meli:', err.message));
    } else {
      console.error('❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en env vars');
    }
  }
};

async function handleStatus(req, res) {
  const supabase = getSupabase();
  const resultado = {
    timestamp: new Date().toISOString(),
    meli_conectado: false,
    usuario_meli: null,
    token_expira: null,
    ultimas_notificaciones: [],
    error: null,
  };
  try {
    const { data: tokenData } = await supabase
      .from('meli_tokens').select('expires_at, meli_user_id, updated_at').eq('id', 1).single();
    if (tokenData) {
      resultado.meli_conectado = true;
      resultado.token_expira = tokenData.expires_at;
      resultado.meli_user_id = tokenData.meli_user_id;
      resultado.token_actualizado = tokenData.updated_at;
      try {
        const token = await getMeliToken();
        const meRes = await fetch('https://api.mercadolibre.com/users/me', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const me = await meRes.json();
        resultado.usuario_meli = me.nickname || me.id;
        resultado.token_valido = !me.error;
      } catch (e) {
        resultado.token_valido = false;
        resultado.token_error = e.message;
      }
    }
  } catch (e) {
    resultado.error = 'MELI no conectado: ' + e.message;
  }
  try {
    const { data: logs } = await supabase
      .from('meli_notify_log').select('*')
      .order('recibido_at', { ascending: false }).limit(10);
    resultado.ultimas_notificaciones = logs || [];
  } catch (_) {
    resultado.ultimas_notificaciones = [];
  }
  return res.json(resultado);
}
