// api/meli/auth.js
// GET /api/meli/auth → redirige al login OAuth de MercadoLibre

module.exports = (req, res) => {
  const clientId = process.env.MELI_CLIENT_ID;
  const redirectUri = process.env.MELI_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).send('Faltan variables de entorno MELI_CLIENT_ID o MELI_REDIRECT_URI');
  }

  const authUrl =
    `https://auth.mercadolibre.com.uy/authorization` +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(authUrl);
};
