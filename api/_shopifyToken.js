// api/_shopifyToken.js
// Helper que devuelve un access_token válido, refrescando si expiró (igual que _meliToken.js)

const { getSupabase } = require('./_supabase');

async function getShopifyToken() {
  const supabase = getSupabase();
  const SHOP = 'martinez-motos.myshopify.com';
  const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

  const { data, error } = await supabase
    .from('shopify_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  // Si no hay token o está por expirar en menos de 1 hora → refrescar
  const needsRefresh = !data || error ||
    (data.expires_at && new Date(data.expires_at) - new Date() < 60 * 60 * 1000);

  if (needsRefresh) {
    const tokenRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });

    const newToken = await tokenRes.json();
    if (!newToken.access_token) throw new Error('No se pudo refrescar el token de Shopify');

    const expiresAt = new Date(Date.now() + (newToken.expires_in || 86400) * 1000).toISOString();

    await supabase.from('shopify_tokens').upsert({
      id: 1,
      shop: SHOP,
      access_token: newToken.access_token,
      scope: newToken.scope || '',
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

    return newToken.access_token;
  }

  return data.access_token;
}

module.exports = { getShopifyToken };
