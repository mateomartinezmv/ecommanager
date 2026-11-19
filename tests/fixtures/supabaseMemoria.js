// Supabase falso en memoria para endpoints de solo lectura (GET). Entiende los filtros que
// usan api/restock.js y sus vecinos: select, eq, neq, gt, gte, in, not (is / in), or (sólo
// "col.is.null,col.eq.valor"), order y range. Imita la semántica de SQL que importa: un neq
// o un gt no devuelven filas con NULL en esa columna.
//
// Uso: supabaseMemoria({ productos: [...], ventas: [...], ... }). Una tabla que no está en el
// objeto responde con el error de "tabla inexistente" de PostgREST, como en producción antes
// de correr una migración.

function supabaseMemoria(tablas) {
  function consulta(nombre) {
    const filtros = [];
    const orden = [];
    let rango = null;
    const q = {
      select() { return q; },
      eq(c, v) { filtros.push(f => f[c] === v); return q; },
      neq(c, v) { filtros.push(f => f[c] !== null && f[c] !== undefined && f[c] !== v); return q; },
      gt(c, v) { filtros.push(f => f[c] !== null && f[c] !== undefined && f[c] > v); return q; },
      gte(c, v) { filtros.push(f => f[c] !== null && f[c] !== undefined && f[c] >= v); return q; },
      in(c, vals) { filtros.push(f => vals.includes(f[c])); return q; },
      not(c, op, v) {
        if (op === 'is') filtros.push(f => f[c] !== null && f[c] !== undefined);
        else if (op === 'in') {
          const vals = String(v).replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/"/g, '').trim());
          filtros.push(f => !vals.includes(f[c]));
        } else throw new Error(`not(${op}) no soportado`);
        return q;
      },
      or(expr) {
        const partes = String(expr).split(',').map(s => s.split('.'));
        filtros.push(f => partes.some(([c, op, v]) =>
          op === 'is' && v === 'null' ? (f[c] === null || f[c] === undefined)
            : op === 'eq' ? String(f[c]) === v : false));
        return q;
      },
      order(c, { ascending = true } = {}) { orden.push([c, ascending]); return q; },
      limit() { return q; },
      range(a, b) { rango = [a, b]; return q; },
      then(ok, mal) {
        if (!(nombre in tablas)) {
          return Promise.resolve({ data: null, error: { code: '42P01', message: `relation "public.${nombre}" does not exist` } }).then(ok, mal);
        }
        let filas = tablas[nombre].filter(f => filtros.every(fn => fn(f)));
        if (orden.length) {
          filas = [...filas].sort((x, y) => {
            for (const [c, asc] of orden) {
              if (x[c] === y[c]) continue;
              return (x[c] < y[c] ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
        }
        // Como la API de verdad: nunca más de 1000 filas por consulta.
        const [a, b] = rango || [0, 999];
        filas = filas.slice(a, Math.min(b, a + 999) + 1);
        return Promise.resolve({ data: filas.map(f => ({ ...f })), error: null }).then(ok, mal);
      },
    };
    return q;
  }
  return { from: consulta };
}

module.exports = { supabaseMemoria };
