// api/meli/callback.js
// GET /api/meli/callback?code=XXX → recibe el code OAuth, obtiene el token y lo guarda en Supabase

const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/?meli=error&msg=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) {
    return res.status(400).send('Falta el parámetro "code" en la URL de callback.');
  }

  try {
    // Intercambiar el code por access_token + refresh_token
    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.MELI_CLIENT_ID,
        client_secret: process.env.MELI_CLIENT_SECRET,
        code,
        redirect_uri: process.env.MELI_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      console.error('Error OAuth MELI:', tokenData);
      return res.redirect(`/?meli=error&msg=${encodeURIComponent(tokenData.message || tokenData.error)}`);
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
    const supabase = getSupabase();

    // Guardar (o actualizar) el token en la tabla meli_tokens
    const { error: dbErr } = await supabase.from('meli_tokens').upsert({
      id: 1,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
      meli_user_id: tokenData.user_id,
      updated_at: new Date().toISOString(),
    });

    if (dbErr) {
      console.error('Error guardando token en Supabase:', dbErr.message);
      return res.redirect(`/?meli=error&msg=${encodeURIComponent('No se pudo guardar el token: ' + dbErr.message)}`);
    }

    console.log(`✅ MELI conectado: user_id=${tokenData.user_id}`);
    res.redirect('/?meli=conectado');
  } catch (err) {
    console.error('Error en callback MELI:', err.message);
    res.redirect(`/?meli=error&msg=${encodeURIComponent(err.message)}`);
  }
};
