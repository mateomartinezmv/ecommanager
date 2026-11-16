// supabase/functions/procesar-orden-meli/index.ts
// APAGADA (16/11/2026). Nadie la llamaba: las órdenes de MELI las procesa EcomManager en
// api/meli/notify.js (webhook) y api/cron/sync-ordenes-meli.js (red de seguridad cada 2 horas).
// La versión vieja calculaba la fecha de la venta con el horario de MELI (-04:00) y dejaba en
// el día anterior las ventas de entre las 00:00 y la 01:00 de Uruguay. El código anterior está
// en el historial de git.

Deno.serve(() =>
  new Response(
    JSON.stringify({
      ok: false,
      error: 'Función apagada: las órdenes de MELI se procesan en EcomManager (api/meli/notify.js).',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } },
  )
);
