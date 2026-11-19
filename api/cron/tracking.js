// api/cron/tracking.js
// Cron — cada 4 horas.
//
// Vuelve a consultar en la naviera cada contenedor que sigue en camino (hoy sólo PIL se
// consulta sola), guarda los movimientos y el arribo, y lleva el arribo a la `llegada` de las
// importaciones que vienen adentro. Avisa por Telegram sólo si pasó algo: cambió el arribo
// estimado, zarpó, llegó a un transbordo o al puerto de destino, o salió de la terminal.

const { getSupabase } = require('../_supabase');
const { enviar } = require('../_telegram');
const T = require('../../public/tracking-contenedores');
const { faltaMigracionTracking, actualizarDesdeNaviera, sincronizarSeguro, mensajeNovedades } = require('../_tracking');

async function leerRelacionadas(supabase, tracking) {
  const ids = (tracking.importaciones || []).map(v => v.id).filter(Boolean);
  if (!ids.length) return { importaciones: [], proveedores: [] };
  const { data: importaciones } = await supabase.from('importaciones').select('*').in('id', ids);
  const provIds = [...new Set((importaciones || []).map(i => i.proveedor_id).filter(Boolean))];
  let proveedores = [];
  if (provIds.length) {
    const { data, error } = await supabase.from('proveedores').select('id, nombre').in('id', provIds);
    if (!error) proveedores = data || [];
  }
  return { importaciones: importaciones || [], proveedores };
}

module.exports = async (req, res) => {
  // Vercel sólo permite llamadas al cron desde su propio sistema
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  try {
    const { data, error } = await supabase.from('trackings').select('*').neq('estado', 'retirado');
    if (error && faltaMigracionTracking(error)) return res.json({ ok: true, omitido: 'falta la migración de trackings' });
    if (error) throw error;

    const resultados = [];
    for (const t of (data || []).filter(x => T.navieraAutomatica(x.naviera))) {
      const r = await actualizarDesdeNaviera(supabase, t);
      if (r.error) {
        resultados.push({ id: t.id, contenedor: t.contenedor, error: r.error });
        continue;
      }
      const sync = await sincronizarSeguro(supabase, r.tracking);
      const { importaciones, proveedores } = await leerRelacionadas(supabase, r.tracking);
      const texto = mensajeNovedades(r.tracking, r.novedades, importaciones, proveedores);
      if (texto) await enviar(texto);
      resultados.push({
        id: t.id, contenedor: t.contenedor, estado: r.tracking.estado, eta: r.tracking.eta,
        avisado: !!texto, importaciones: sync.actualizadas.length,
      });
    }
    console.log('tracking:', JSON.stringify(resultados));
    return res.json({ ok: true, consultados: resultados.length, resultados });
  } catch (err) {
    console.error('Error en cron/tracking.js:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
