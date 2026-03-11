// api/shopify/get-token.js
// GET /api/shopify/get-token → obtiene y guarda el access token de Shopify
// ⚠️ ELIMINAR ESTE ARCHIVO después de obtener el token

const { getSupabase } = require('../_supabase');

module.exports = async (req, res) => {
  const SHOP = 'martinez-motos.myshopify.com';
  const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

  try {
    const tokenRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });

    const data = await tokenRes.json();

    if (!data.access_token) {
      return res.json({ error: 'Sin token', respuesta: data });
    }

    // Guardar en Supabase
    const supabase = getSupabase();
    const { error } = await supabase.from('shopify_tokens').upsert({
      id: 1,
      shop: SHOP,
      access_token: data.access_token,
      scope: data.scope || '',
      expires_at: new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (error) throw error;

    res.json({
      ok: true,
      token: data.access_token,
      scope: data.scope,
      expira_en: data.expires_in + ' segundos (24hs)',
      guardado_en: 'Supabase ✅',
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
