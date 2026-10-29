// api/_avisosStock.js
// Waitlist: clientes que esperan que vuelva a entrar un producto (tabla avisos_stock).
//
// Un aviso pasa de 'esperando' a 'listo' sólo cuando llega una importación que trae el SKU
// (lo llama /api/importaciones en la transición a recibida). No se engancha en
// sincronizarStock a propósito: ahí también pasan los ajustes a mano, las devoluciones y
// las ventas canceladas, y un cliente no tiene que recibir "volvió a entrar" porque alguien
// devolvió una unidad o corrigió un conteo.
//
// El WhatsApp lo manda el usuario desde Stock → 🔔 Waitlist (wa.me con el texto armado);
// al hacerlo el aviso pasa a 'avisado'.

const ESTADOS = ['esperando', 'listo', 'avisado', 'cancelado'];
const ABIERTOS = ['esperando', 'listo'];

// La tabla todavía no existe en Supabase (no se corrió la migración 20261029000000).
function faltaMigracionAvisos(error) {
  if (!error) return false;
  if (['PGRST205', '42P01'].includes(error.code)) return true;
  const msg = String(error.message || '');
  return /avisos_stock/i.test(msg) && /relation|table|tabla|schema|exist/i.test(msg);
}

// Pasa a 'listo' los avisos que esperaban alguno de estos SKUs, anotando qué importación
// los trajo. Sólo toca los que están 'esperando': si la misma importación se marca dos
// veces, o llega otra con el mismo SKU, los que ya estaban listos o avisados no se pisan.
// Nunca lanza: la importación ya se guardó y el stock ya se sumó, un problema acá se
// devuelve para que la pantalla lo muestre.
async function marcarAvisosListos(supabase, skus, importacionId) {
  const buscados = [...new Set((skus || []).filter(Boolean))];
  if (!buscados.length) return { listos: [] };

  try {
    const { data, error } = await supabase
      .from('avisos_stock')
      .update({
        estado: 'listo',
        importacion_id: importacionId != null ? String(importacionId) : null,
        listo_at: new Date().toISOString(),
      })
      .in('sku', buscados)
      .eq('estado', 'esperando')
      .select('id, sku, cliente_id');
    if (error) {
      if (faltaMigracionAvisos(error)) return { listos: [], migracionPendiente: true };
      throw error;
    }
    return { listos: data || [] };
  } catch (err) {
    console.error('Error marcando avisos de stock como listos:', err);
    return { listos: [], error: err.message };
  }
}

module.exports = { ESTADOS, ABIERTOS, faltaMigracionAvisos, marcarAvisosListos };
