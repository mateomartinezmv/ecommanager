// api/_meliToken.js
// Helper que devuelve un access_token válido, refrescando si expiró

const { getSupabase } = require('./_supabase');

async function getMeliToken() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('meli_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) throw new Error('MELI no está conectado. Autorizá la app primero.');

  const now = new Date();
  const expiresAt = new Date(data.expires_at);

  // Si expira en menos de 5 minutos, refrescar
  if (expiresAt - now < 5 * 60 * 1000) {
    const refreshRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.MELI_CLIENT_ID,
        client_secret: process.env.MELI_CLIENT_SECRET,
        refresh_token: data.refresh_token,
      }),
    });

    const newToken = await refreshRes.json();
    if (newToken.error) throw new Error('No se pudo refrescar el token de MELI: ' + newToken.message);

    const newExpiry = new Date(Date.now() + newToken.expires_in * 1000).toISOString();
    await supabase.from('meli_tokens').update({
      access_token: newToken.access_token,
      refresh_token: newToken.refresh_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);

    return newToken.access_token;
  }

  return data.access_token;
}

module.exports = { getMeliToken };
