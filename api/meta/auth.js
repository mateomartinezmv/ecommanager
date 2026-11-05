// api/meta/auth.js
// GET /api/meta/auth → redirige al inicio de sesión de Facebook para conectar Instagram

const { SCOPES } = require('../_metaInstagram');

module.exports = (req, res) => {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;

  if (!appId || !redirectUri) {
    return res.status(500).send('Faltan variables de entorno META_APP_ID o META_REDIRECT_URI');
  }

  const authUrl =
    `https://www.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/dialog/oauth` +
    `?client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SCOPES.join(','))}` +
    `&response_type=code`;

  res.redirect(authUrl);
};
