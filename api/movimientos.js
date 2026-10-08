// api/movimientos.js
// Otros gastos y otros ingresos del negocio (packaging, envíos por cambios, rendimientos MP…)
// y las categorías con las que se clasifican.
//
// Movimientos:
//   GET    /api/movimientos                      → { movimientos, categorias }
//   GET    /api/movimientos?desde=&hasta=        → filtrado por fecha
//   POST   /api/movimientos                      → crear
//   PUT    /api/movimientos?id=MOV-123           → editar
//   DELETE /api/movimientos?id=MOV-123           → eliminar
//
// Categorías (mismo archivo para no sumar otra función serverless):
//   POST   /api/movimientos?recurso=categoria    → crear
//   PUT    /api/movimientos?recurso=categoria&id=envios → editar
//   DELETE /api/movimientos?recurso=categoria&id=envios → eliminar (sólo si no tiene movimientos)

const { getSupabase } = require('./_supabase');

const TIPOS = ['gasto', 'ingreso'];
const TIPOS_CATEGORIA = ['gasto', 'ingreso', 'ambos'];
const MONEDAS = ['UYU', 'USD'];

// 'Rendimientos Mercado Pago' → 'rendimientos_mercado_pago'
function slugify(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // saca los acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

// Deja el movimiento listo para guardar: valida y calcula monto_uyu con la cotización que
// manda el front (la que el usuario tiene configurada hoy), para que el histórico en pesos
// no se mueva cuando cambie el tipo de cambio.
function armarMovimiento(body) {
  const tipo = String(body.tipo || '').toLowerCase();
  if (!TIPOS.includes(tipo)) {
    return { error: "El campo tipo debe ser 'gasto' o 'ingreso'" };
  }

  const concepto = String(body.concepto || '').trim();
  if (!concepto) return { error: 'El concepto es obligatorio' };

  const monto = num(body.monto);
  if (!Number.isFinite(monto) || monto < 0) return { error: 'El monto tiene que ser un número mayor o igual a 0' };

  const moneda = MONEDAS.includes(String(body.moneda || '').toUpperCase())
    ? String(body.moneda).toUpperCase()
    : 'UYU';

  let cotizacion = null;
  let montoUyu = monto;
  if (moneda === 'USD') {
    cotizacion = num(body.cotizacion);
    if (!Number.isFinite(cotizacion) || cotizacion <= 0) {
      return { error: 'Para un movimiento en USD hace falta la cotización del dólar' };
    }
    montoUyu = parseFloat((monto * cotizacion).toFixed(2));
  }

  const fecha = String(body.fecha || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: 'La fecha es obligatoria (YYYY-MM-DD)' };

  return {
    movimiento: {
      tipo,
      fecha,
      categoria_id: body.categoriaId || body.categoria_id || null,
      concepto,
      monto,
      moneda,
      cotizacion,
      monto_uyu: montoUyu,
      // Un gasto nunca computa contra el tope de facturación.
      cuenta_facturacion: tipo === 'ingreso' && !!(body.cuentaFacturacion ?? body.cuenta_facturacion),
      venta_id: body.ventaId || body.venta_id || null,
      notas: (body.notas || '').trim() || null,
    },
  };
}

function armarCategoria(body) {
  const nombre = String(body.nombre || '').trim();
  if (!nombre) return { error: 'El nombre de la categoría es obligatorio' };

  const tipo = String(body.tipo || 'ambos').toLowerCase();
  if (!TIPOS_CATEGORIA.includes(tipo)) {
    return { error: "El tipo de la categoría debe ser 'gasto', 'ingreso' o 'ambos'" };
  }

  const color = /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : '#64748b';
  const orden = Number.isFinite(num(body.orden)) ? Math.round(num(body.orden)) : 100;

  return { categoria: { nombre, tipo, color, orden } };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();
  const esCategoria = req.query.recurso === 'categoria';

  try {
    // ── Categorías ──────────────────────────────────────────────────────────
    if (esCategoria) {
      if (req.method === 'POST') {
        const { categoria, error: valErr } = armarCategoria(req.body || {});
        if (valErr) return res.status(400).json({ error: valErr });

        const id = slugify(categoria.nombre) || 'cat_' + Date.now();
        const { data: yaExiste } = await supabase
          .from('movimiento_categorias').select('id').eq('id', id).maybeSingle();
        if (yaExiste) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });

        const { data, error } = await supabase
          .from('movimiento_categorias').insert({ id, ...categoria }).select().single();
        if (error) throw error;
        return res.json(data);
      }

      if (req.method === 'PUT') {
        const id = req.query.id;
        if (!id) return res.status(400).json({ error: 'Falta id' });
        const { categoria, error: valErr } = armarCategoria(req.body || {});
        if (valErr) return res.status(400).json({ error: valErr });

        // El id es el slug original: renombrar la categoría no lo cambia, así que los
        // movimientos ya cargados siguen apuntando a ella.
        const { data, error } = await supabase
          .from('movimiento_categorias').update(categoria).eq('id', id).select().single();
        if (error) throw error;
        return res.json(data);
      }

      if (req.method === 'DELETE') {
        const id = req.query.id;
        if (!id) return res.status(400).json({ error: 'Falta id' });

        // Borrar una categoría en uso dejaría los movimientos sin clasificar sin avisar, así
        // que se rechaza y se dice cuántos hay que mover primero.
        const { count, error: countErr } = await supabase
          .from('movimientos').select('id', { count: 'exact', head: true }).eq('categoria_id', id);
        if (countErr) throw countErr;
        if (count > 0) {
          return res.status(409).json({
            error: `La categoría tiene ${count} movimiento${count === 1 ? '' : 's'} cargado${count === 1 ? '' : 's'}. ` +
                   'Cambiales la categoría antes de eliminarla.',
            movimientos: count,
          });
        }

        const { error } = await supabase.from('movimiento_categorias').delete().eq('id', id);
        if (error) throw error;
        return res.json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Movimientos ─────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      let query = supabase.from('movimientos').select('*').order('fecha', { ascending: false });
      if (req.query.desde) query = query.gte('fecha', req.query.desde);
      if (req.query.hasta) query = query.lte('fecha', req.query.hasta);
      if (TIPOS.includes(req.query.tipo)) query = query.eq('tipo', req.query.tipo);

      const [{ data: movimientos, error: movErr }, { data: categorias, error: catErr }] = await Promise.all([
        query,
        supabase.from('movimiento_categorias').select('*').order('orden', { ascending: true }),
      ]);
      if (movErr) throw movErr;
      if (catErr) throw catErr;

      return res.json({ movimientos: movimientos || [], categorias: categorias || [] });
    }

    if (req.method === 'POST') {
      const { movimiento, error: valErr } = armarMovimiento(req.body || {});
      if (valErr) return res.status(400).json({ error: valErr });

      const { data, error } = await supabase
        .from('movimientos')
        .insert({ id: 'MOV-' + Date.now(), ...movimiento })
        .select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'PUT') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });

      const { movimiento, error: valErr } = armarMovimiento(req.body || {});
      if (valErr) return res.status(400).json({ error: valErr });

      const { data, error } = await supabase
        .from('movimientos').update(movimiento).eq('id', id).select().single();
      if (error) throw error;
      return res.json(data);
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const { error } = await supabase.from('movimientos').delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/movimientos:', err);
    res.status(500).json({ error: err.message });
  }
};
