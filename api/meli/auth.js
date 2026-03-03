// api/meli/auth.js
// GET /api/meli/auth → redirige al login de Mercado Libre

module.exports = (req, res) => {
  const clientId = process.env.MELI_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.MELI_REDIRECT_URI);
  const url = `https://auth.mercadolibre.com.uy/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}`;
  res.redirect(url);
};
