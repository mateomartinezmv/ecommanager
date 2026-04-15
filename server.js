const express = require('express');
const path = require('path');

const app = express();

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API routes
app.all('/api/clientes',              require('./api/clientes'));
app.all('/api/productos',             require('./api/productos'));
app.all('/api/ventas',                require('./api/ventas'));
app.all('/api/envios',                require('./api/envios'));
app.all('/api/transportistas',        require('./api/transportistas'));
app.all('/api/importaciones',         require('./api/importaciones'));
app.all('/api/restock',               require('./api/restock'));

app.all('/api/meli/auth',             require('./api/meli/auth'));
app.all('/api/meli/callback',         require('./api/meli/callback'));
app.all('/api/meli/notify',           require('./api/meli/notify'));
app.all('/api/meli/importar',         require('./api/meli/importar'));
app.all('/api/meli/reprocesar',       require('./api/meli/reprocesar'));
app.all('/api/meli/actualizar-envios',require('./api/meli/actualizar-envios'));
app.all('/api/meli/etiqueta',         require('./api/meli/etiqueta'));
app.all('/api/meli/sync-stock',       require('./api/meli/sync-stock'));

app.all('/api/shopify/notify',        require('./api/shopify/notify'));
app.all('/api/shopify/productos',     require('./api/shopify/productos'));
app.all('/api/shopify/buscar-sku',    require('./api/shopify/buscar-sku'));
app.all('/api/shopify/sync-stock',    require('./api/shopify/sync-stock'));

// Frontend estático desde /public
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: cualquier ruta no-API sirve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EcomManager corriendo en puerto ${PORT}`);
});
