// api/_syncOrdenes.js
// Red de seguridad de las ventas de MELI (api/cron/sync-ordenes-meli.js, cada 2 horas).
//
// Las ventas entran por el webhook (api/meli/notify.js). Si un aviso de MELI se pierde, la
// venta no se registra y el stock queda inflado. Antes esto lo cubría la Edge Function de
// Supabase sync-meli-orders, con una copia vieja de la lógica del webhook (fecha en -04:00,
// alta automática de productos). Ahora se revisan las últimas órdenes pagadas y las que no
// están en ventas se mandan por el mismo webhook, que es idempotente: si la venta ya existe
// no descuenta stock otra vez.
//
// Cada orden se intenta una sola vez (meli_notify_log, topic 'sync_ordenes'): si no se pudo
// registrar (una publicación sin vincular), el webhook ya avisó por Telegram y no hace falta
// repetirlo cada 2 horas.

const TOPIC = 'sync_ordenes';
const LIMITE = 50;

async function ordenesPagadasRecientes(token, { limite = LIMITE } = {}) {
  const get = async (ruta) => {
    const r = await fetch(`https://api.mercadolibre.com${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(`MELI ${ruta.split('?')[0]}: ${data.message || data.error || `HTTP ${r.status}`}`);
    return data;
  };
  const me = await get('/users/me');
  const data = await get(`/orders/search?seller=${me.id}&order.status=paid&sort=date_desc&limit=${limite}`);
  return (data.results || []).map(o => String(o.id));
}

// procesar(orderId) manda la orden por el webhook; listar() trae los ids de órdenes recientes.
async function sincronizarOrdenes(supabase, { listar, procesar }) {
  const ids = [...new Set(await listar())];
  if (!ids.length) return { revisadas: 0, ya_estaban: 0, procesadas: [] };

  const [{ data: ventas, error: errV }, { data: intentos, error: errL }] = await Promise.all([
    supabase.from('ventas').select('orden_meli').in('orden_meli', ids),
    supabase.from('meli_notify_log').select('resource').eq('topic', TOPIC).in('resource', ids),
  ]);
  if (errV) throw new Error(`ventas: ${errV.message}`);
  if (errL) throw new Error(`meli_notify_log: ${errL.message}`);

  const yaEstan = new Set((ventas || []).map(v => String(v.orden_meli)));
  const intentadas = new Set((intentos || []).map(l => String(l.resource)));
  const faltan = ids.filter(id => !yaEstan.has(id) && !intentadas.has(id));

  const procesadas = [];
  for (const id of faltan) {
    let error = null;
    try {
      await procesar(id);
    } catch (err) {
      error = err.message;
    }
    const { data: ahora } = await supabase.from('ventas').select('id').eq('orden_meli', id);
    const registrada = !!(ahora && ahora.length);
    await supabase.from('meli_notify_log').insert({
      topic: TOPIC, resource: id, error: registrada ? null : (error || 'no se registró (¿publicación sin vincular?)'),
    });
    procesadas.push({ orden: id, registrada, error });
  }

  return { revisadas: ids.length, ya_estaban: ids.length - faltan.length, procesadas };
}

module.exports = { sincronizarOrdenes, ordenesPagadasRecientes, TOPIC };
