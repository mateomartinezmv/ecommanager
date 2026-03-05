// api/meli/status.js
// GET /api/meli/status → diagnóstico de conexión MELI y últimas notificaciones

const { getMeliToken } = require('../_meliToken');
const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  const resultado = {
    timestamp: new Date().toISOString(),
    meli_conectado: false,
    usuario_meli: null,
    token_expira: null,
    ultimas_notificaciones: [],
    error: null,
  };

  // Verificar token MELI
  try {
    const { data: tokenData } = await supabase
      .from('meli_tokens')
      .select('expires_at, meli_user_id, updated_at')
      .eq('id', 1)
      .single();

    if (tokenData) {
      resultado.meli_conectado = true;
      resultado.token_expira = tokenData.expires_at;
      resultado.meli_user_id = tokenData.meli_user_id;
      resultado.token_actualizado = tokenData.updated_at;

      // Verificar que el token funcione llamando a la API
      try {
        const token = await getMeliToken();
        const meRes = await fetch('https://api.mercadolibre.com/users/me', {
          headers: { 'Authorization': `Bearer ${token}` }
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

  // Últimas notificaciones recibidas (si existe la tabla de logs)
  try {
    const { data: logs } = await supabase
      .from('meli_notify_log')
      .select('*')
      .order('recibido_at', { ascending: false })
      .limit(10);
    resultado.ultimas_notificaciones = logs || [];
  } catch (_) {
    resultado.ultimas_notificaciones = [];
    resultado.nota_logs = 'Tabla meli_notify_log no existe aún (se crea con la primera notificación si la creás en Supabase)';
  }

  res.json(resultado);
};
