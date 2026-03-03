// api/meli/callback.js
// GET /api/meli/callback?code=XXX → intercambia code por token y lo guarda

const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el código de autorización.');

  try {
    // Intercambiar code por access_token
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

    const token = await tokenRes.json();
    if (token.error) throw new Error(token.message || token.error);

    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

    // Guardar token en Supabase (siempre id=1, un solo registro)
    const supabase = getSupabase();
    const { error } = await supabase.from('meli_tokens').upsert({
      id: 1,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: expiresAt,
      meli_user_id: String(token.user_id),
      updated_at: new Date().toISOString(),
    });

    if (error) throw error;

    // Redirigir al frontend con éxito
    res.redirect('/?meli=conectado');
  } catch (err) {
    console.error('MELI callback error:', err);
    res.redirect('/?meli=error&msg=' + encodeURIComponent(err.message));
  }
};
