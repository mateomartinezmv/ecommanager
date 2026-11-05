// api/meta/callback.js
// GET /api/meta/callback?code=XXX → recibe el code de Facebook, consigue el token de la página
// que tiene vinculada la cuenta de Instagram y lo guarda en Supabase.
//
// El token de página que sale de un token de usuario de larga duración no vence, así que
// no hace falta refrescarlo como el de MELI. Deja de andar solo si se cambia la contraseña
// de Facebook o se le quitan los permisos a la app: en ese caso se vuelve a conectar.

const { getSupabase } = require('../_supabase');
const { graph, elegirCuenta } = require('../_metaInstagram');

module.exports = async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/?meta=error&msg=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) {
    return res.status(400).send('Falta el parámetro "code" en la URL de callback.');
  }

  try {
    const app = { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET };

    // 1. code → token de usuario (dura una o dos horas)
    const corto = await graph(fetch, 'GET', 'oauth/access_token',
      { ...app, redirect_uri: process.env.META_REDIRECT_URI, code }, '');

    // 2. → token de usuario de larga duración (~60 días)
    const largo = await graph(fetch, 'GET', 'oauth/access_token',
      { ...app, grant_type: 'fb_exchange_token', fb_exchange_token: corto.access_token }, '');

    // 3. Páginas del usuario, con su token (que no vence) y la cuenta de Instagram vinculada
    const { data: paginas } = await graph(fetch, 'GET', 'me/accounts',
      { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' }, largo.access_token);

    const pagina = elegirCuenta(paginas, process.env.META_IG_USERNAME);
    if (!pagina) {
      return res.redirect(`/?meta=error&msg=${encodeURIComponent(
        'Ninguna de tus páginas de Facebook tiene una cuenta de Instagram profesional vinculada.')}`);
    }

    const { error: dbErr } = await getSupabase().from('meta_tokens').upsert({
      id: 1,
      page_id: pagina.id,
      page_name: pagina.name,
      page_access_token: pagina.access_token,
      ig_user_id: pagina.instagram_business_account.id,
      ig_username: pagina.instagram_business_account.username || null,
      user_token_expires_at: largo.expires_in
        ? new Date(Date.now() + largo.expires_in * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    });

    if (dbErr) {
      console.error('Error guardando token de Meta en Supabase:', dbErr.message);
      return res.redirect(`/?meta=error&msg=${encodeURIComponent('No se pudo guardar el token: ' + dbErr.message)}`);
    }

    console.log(`✅ Instagram conectado: @${pagina.instagram_business_account.username} (página ${pagina.name})`);
    res.redirect('/?meta=conectado');
  } catch (err) {
    console.error('Error en callback de Meta:', err.message);
    res.redirect(`/?meta=error&msg=${encodeURIComponent(err.message)}`);
  }
};
