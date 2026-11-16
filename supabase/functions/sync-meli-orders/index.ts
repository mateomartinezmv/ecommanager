// supabase/functions/sync-meli-orders/index.ts
// APAGADA (16/11/2026). La reemplaza api/cron/sync-ordenes-meli.js en EcomManager, que cada 2
// horas manda por el webhook (api/meli/notify.js) las órdenes pagadas que no están en ventas.
// Esta versión vieja tenía una copia de la lógica del webhook que había quedado atrás (fecha
// en -04:00, alta automática de productos). El cron de Supabase que la llamaba
// (cron.job "sync-meli-orders") se desactivó. El código anterior está en el historial de git.

Deno.serve(() =>
  new Response(
    JSON.stringify({
      ok: false,
      error: 'Función apagada: la reemplaza api/cron/sync-ordenes-meli.js en EcomManager.',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } },
  )
);
