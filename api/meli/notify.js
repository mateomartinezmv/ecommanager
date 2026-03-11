// api/meli/notify.js
// POST /api/meli/notify → recibe notificación de MELI y delega a Supabase Edge Function
// Vercel no puede hacer fetch saliente en plan gratuito, pero SÍ puede llamar a Supabase

const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const body = req.body || {};
  const { topic, resource } = body;

  const supabase = getSupabase();

  // 1. Guardar log siempre
  try {
    await supabase.from('meli_notify_log').insert({
      topic: topic || 'desconocido',
      resource: resource || '',
      raw: JSON.stringify(body),
      recibido_at: new Date().toISOString(),
    });
  } catch (_) {}

  console.log(`[MELI NOTIFY] topic=${topic} resource=${resource}`);

  // 2. Si es una orden, invocar la Edge Function de Supabase para procesarla
  if (topic === 'orders_v2' || topic === 'orders') {
    const orderId = String(resource || '').replace(/\D/g, '').trim();
    if (orderId) {
      try {
        // Llamar a la Edge Function de Supabase (esto SÍ funciona desde Vercel)
        const { error } = await supabase.functions.invoke('procesar-orden-meli', {
          body: { orden_id: orderId },
        });
        if (error) {
          console.error('[MELI NOTIFY] Error invocando Edge Function:', error.message);
        } else {
          console.log(`[MELI NOTIFY] ✅ Edge Function invocada para orden ${orderId}`);
        }
      } catch (err) {
        console.error('[MELI NOTIFY] Error:', err.message);
      }
    }
  }

  return res.status(200).json({ ok: true });
};
