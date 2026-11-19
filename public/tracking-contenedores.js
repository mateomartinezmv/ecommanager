// public/tracking-contenedores.js
// Seguimiento de los contenedores en los que viajan las importaciones. Sólo reglas, sin
// pantalla: la usan importaciones.html, api/tracking.js (vía require) y los tests.
//
// Por qué existe: cada PI se pide por separado y a cada una se le calcula su llegada, pero el
// importador junta varias PIs en un mismo contenedor y llegan todas el mismo día. El
// contenedor (con su naviera) es lo único que dice cuándo llega de verdad, así que acá:
//   · se valida el número del contenedor (ISO 6346: 4 letras, 6 dígitos y el de control),
//   · se lee en qué etapa está a partir de los movimientos que informa la naviera,
//   · se calcula el arribo estimado al puerto de destino y cuánto avanzó el viaje, y
//   · se suma lo que falta pagar de las PIs que vienen adentro para la fecha del arribo.

(function (raiz) {
  const CI = raiz.CostoImportacion || (typeof require === 'function' ? require('./costo-importacion') : null);

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const r2 = n => Math.round(n * 100) / 100;

  // ── Número de contenedor (ISO 6346) ─────────────────────────────────────────────
  // Las letras valen de 10 a 38 salteando los múltiplos de 11; cada posición pesa 2^i y el
  // dígito de control es (suma mod 11) mod 10. Sirve para atajar un número mal copiado.
  const VALOR_LETRA = {};
  (function () {
    let v = 10;
    for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (v % 11 === 0) v++;
      VALOR_LETRA[l] = v++;
    }
  })();

  function normalizarContenedor(s) {
    return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function formatoContenedorValido(c) {
    return /^[A-Z]{4}\d{7}$/.test(normalizarContenedor(c));
  }

  function digitoControl(c) {
    const s = normalizarContenedor(c).slice(0, 10);
    if (!/^[A-Z]{4}\d{6}$/.test(s)) return null;
    let suma = 0;
    for (let i = 0; i < 10; i++) {
      const ch = s[i];
      const valor = i < 4 ? VALOR_LETRA[ch] : Number(ch);
      suma += valor * Math.pow(2, i);
    }
    return (suma % 11) % 10;
  }

  function digitoControlValido(c) {
    const s = normalizarContenedor(c);
    return formatoContenedorValido(s) && digitoControl(s) === Number(s[10]);
  }

  // PCIU8919128 → "PCIU 891912-8", como lo escriben los importadores.
  function formatearContenedor(c) {
    const s = normalizarContenedor(c);
    return formatoContenedorValido(s) ? `${s.slice(0, 4)} ${s.slice(4, 10)}-${s[10]}` : String(c ?? '');
  }

  // ── Navieras ────────────────────────────────────────────────────────────────────
  // `automatica`: el CRM consulta solo el estado en la web de la naviera (api/_pil.js). Del
  // resto se guarda a mano el arribo y el estado, con el link de seguimiento que se pegue.
  const NAVIERAS = [
    { id: 'PIL', nombre: 'PIL (Pacific International Lines)', automatica: true,
      link: c => `https://www.pilship.com/digital-solutions/?tab=customer&id=track-trace&label=containerTandT&module=TrackContStatus&refNo=${encodeURIComponent(c)}` },
    { id: 'MSC', nombre: 'MSC' },
    { id: 'MAERSK', nombre: 'Maersk' },
    { id: 'COSCO', nombre: 'COSCO' },
    { id: 'CMA', nombre: 'CMA CGM' },
    { id: 'HAPAG', nombre: 'Hapag-Lloyd' },
    { id: 'ONE', nombre: 'ONE (Ocean Network Express)' },
    { id: 'EVERGREEN', nombre: 'Evergreen' },
    { id: 'ZIM', nombre: 'ZIM' },
    { id: 'OTRA', nombre: 'Otra naviera' },
  ];

  function naviera(id) {
    return NAVIERAS.find(n => n.id === String(id || '').toUpperCase()) || NAVIERAS[NAVIERAS.length - 1];
  }

  function navieraAutomatica(id) { return !!naviera(id).automatica; }

  // El link que se pegó a mano manda; si no, el de la naviera armado con el número.
  function linkSeguimiento(t) {
    if (t?.link_seguimiento) return t.link_seguimiento;
    const n = naviera(t?.naviera);
    const c = normalizarContenedor(t?.contenedor);
    return n.link && c ? n.link(c) : null;
  }

  // ── Etapas ──────────────────────────────────────────────────────────────────────
  // `paso` ordena las etapas para el avance; transbordo y navegando son el mismo paso.
  const ESTADOS = [
    { id: 'reservado',  icono: '📋', label: 'Reservado',               paso: 0 },
    { id: 'origen',     icono: '📦', label: 'Cargando en origen',      paso: 1 },
    { id: 'terminal',   icono: '⚓', label: 'En la terminal de origen', paso: 2 },
    { id: 'navegando',  icono: '🚢', label: 'Navegando',               paso: 3 },
    { id: 'transbordo', icono: '🔁', label: 'En transbordo',           paso: 3 },
    { id: 'en_puerto',  icono: '🏁', label: 'En el puerto de destino', paso: 4 },
    { id: 'retirado',   icono: '✅', label: 'Retirado del puerto',     paso: 5 },
  ];

  function estadoInfo(id) {
    return ESTADOS.find(e => e.id === id) || ESTADOS[0];
  }

  // Qué es cada movimiento que informa la naviera (PIL los nombra en inglés).
  function tipoEvento(nombre) {
    const s = String(nombre || '').toLowerCase();
    if (/empty/.test(s) && /return/.test(s)) return 'vacio_devuelto';
    if (/empty/.test(s) && /(releas|pick)/.test(s)) return 'vacio_retirado';
    if (/gate\s*in/.test(s)) return 'gate_in';
    if (/gate\s*out/.test(s)) return 'gate_out';
    if (/discharg|unload/.test(s)) return 'descarga';
    if (/load/.test(s)) return 'carga';
    return 'otro';
  }

  const TEXTO_EVENTO = {
    vacio_retirado: 'Retiraron el contenedor vacío para cargarlo',
    gate_in: 'Entró a la terminal del puerto',
    carga: 'Cargado en el buque',
    descarga: 'Descargado del buque',
    gate_out: 'Salió de la terminal',
    vacio_devuelto: 'Devolvieron el contenedor vacío',
  };

  function textoEvento(ev) {
    return TEXTO_EVENTO[tipoEvento(ev?.evento)] || ev?.evento || '—';
  }

  const ordenEvento = e => `${e.fecha || '9999-99-99'} ${e.hora || '99:99'}`;

  // Todo lo que se deduce de los movimientos: etapa, zarpe, arribo, puertos y buque.
  //   eventos: [{ fecha, hora, estimado, evento, lugar, buque, viaje }] en el orden de la
  //            naviera (los que todavía no tienen fecha van al final, sin fecha).
  //   tramos:  el resumen de la naviera, [{ puerto, codigo, buque, viaje, proximo, eta_proximo }].
  // El arribo es la última descarga (la del puerto final): las anteriores son transbordos.
  function derivarDeEventos(eventos, tramos) {
    const lista = (Array.isArray(eventos) ? eventos : []).filter(Boolean);
    const legs = (Array.isArray(tramos) ? tramos : []).filter(Boolean);
    const conTipo = lista.map((e, i) => ({ ...e, i, tipo: tipoEvento(e.evento) }));
    const cargas = conTipo.filter(e => e.tipo === 'carga');
    const descargas = conTipo.filter(e => e.tipo === 'descarga');
    const primeraCarga = cargas[0] || null;
    const ultimaDescarga = descargas[descargas.length - 1] || null;

    // Se recorren los movimientos que ya pasaron (con fecha y sin el * de estimado), en orden.
    // Un movimiento que no se reconoce no cambia la etapa.
    const reales = conTipo.filter(e => e.fecha && !e.estimado)
      .sort((a, b) => ordenEvento(a).localeCompare(ordenEvento(b)) || a.i - b.i);
    const llegoAlFinal = !!ultimaDescarga && reales.some(e => e.i === ultimaDescarga.i);
    const paso = id => estadoInfo(id).paso;
    let estado = 'reservado';
    for (const e of reales) {
      if (e.tipo === 'vacio_retirado' && paso(estado) < 1) estado = 'origen';
      else if (e.tipo === 'gate_in' && paso(estado) < 2) estado = 'terminal';
      else if (e.tipo === 'carga') estado = 'navegando';
      else if (e.tipo === 'descarga') estado = e.i === ultimaDescarga.i ? 'en_puerto' : 'transbordo';
      else if ((e.tipo === 'gate_out' || e.tipo === 'vacio_devuelto') && llegoAlFinal) estado = 'retirado';
    }

    const ultimoLeg = legs[legs.length - 1] || null;
    const cargaActual = cargas.filter(e => e.fecha && !e.estimado).pop() || primeraCarga;
    return {
      estado,
      etd: primeraCarga?.fecha || legs[0]?.salida || null,
      zarpo: !!(primeraCarga && primeraCarga.fecha && !primeraCarga.estimado),
      eta: ultimaDescarga?.fecha || ultimoLeg?.eta_proximo || null,
      arribo: !!(ultimaDescarga && ultimaDescarga.fecha && !ultimaDescarga.estimado),
      puerto_origen: primeraCarga?.lugar || legs[0]?.puerto || null,
      puerto_destino: ultimaDescarga?.lugar || ultimoLeg?.proximo || null,
      buque: cargaActual?.buque || legs[0]?.buque || null,
      viaje: cargaActual?.viaje || legs[0]?.viaje || null,
      transbordos: descargas.slice(0, -1).map(e => e.lugar).filter(Boolean),
    };
  }

  // ── Fechas ──────────────────────────────────────────────────────────────────────
  function diasEntre(desde, hasta) {
    if (!desde || !hasta) return null;
    const a = Date.parse(String(desde).slice(0, 10) + 'T00:00:00Z');
    const b = Date.parse(String(hasta).slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  // Cuánto del viaje se hizo (0 a 1), para ubicar el barco en la línea. Antes de zarpar es
  // 0 y en el puerto de destino 1; navegando, la proporción del tiempo entre zarpe y arribo.
  function progresoViaje(t, hoy) {
    const paso = estadoInfo(t?.estado).paso;
    if (paso >= 4) return 1;
    if (paso < 3) return 0;
    const total = diasEntre(t?.etd, t?.eta);
    const hecho = diasEntre(t?.etd, hoy);
    if (!total || total <= 0 || hecho == null) return 0.5;
    return Math.min(0.97, Math.max(0.03, hecho / total));
  }

  // ── PIs del contenedor y lo que falta pagar ─────────────────────────────────────
  const ESTADOS_LLEGADOS = ['arrived', 'recibido', 'en_deposito'];
  const ESTADOS_CANCELADOS = ['cancelled', 'cancelada'];

  // Número de PI de una importación. Lo que se cargó en el contenedor manda; si no, se busca
  // en las notas ("PI14175", "PI.13772", "PI 261107001 de …").
  function piDe(imp, vinculo) {
    if (vinculo?.pi) return String(vinculo.pi).trim();
    const m = /\bPI\s*[.#:°º-]?\s*(\d[\d.]*\d|\d)/i.exec(String(imp?.notas || ''));
    return m ? m[1].replace(/\./g, '') : null;
  }

  // Lo que todavía no se pagó de una importación, renglón por renglón.
  //   · Con puesta en puerto: los pagos sin marcar (incluido el all in, que vence al arribo).
  //   · Del esquema anterior: si tiene saldo pendiente, la segunda mitad de la PI
  //     (productos + puesta FOB / shipping de la PI).
  function pendienteDeImportacion(imp) {
    if (!imp || ESTADOS_CANCELADOS.includes(imp.estado || imp.status)) return { monto: 0, lineas: [], modelo: null };
    if (CI && CI.esPuerto(imp)) {
      const lineas = (Array.isArray(imp.pagos) ? imp.pagos : []).filter(p => p && !p.pagado).map(p => ({
        id: p.id, concepto: p.concepto, a: p.a, estimado: p.estimado || null,
        monto: r2(num(p.monto) + Math.max(0, num(p.fee))),
      }));
      return { monto: r2(lineas.reduce((s, l) => s + l.monto, 0)), lineas, modelo: 'puerto' };
    }
    if (!imp.saldo_pendiente) return { monto: 0, lineas: [], modelo: 'iva' };
    const totalPI = r2((CI ? CI.costoChina(imp.items) : 0) + num(imp.traslado));
    const segunda = r2(totalPI - r2(totalPI / 2));
    return {
      monto: segunda, modelo: 'iva',
      lineas: [{ id: 'saldo_pi', concepto: '2da mitad de la PI', a: 'proveedor', monto: segunda, totalPI }],
    };
  }

  // Las PIs del contenedor con su importación, lo que se había calculado y lo que falta pagar.
  //   tracking.importaciones: [{ id, pi, descripcion, llegada_calculada }]
  function resumenContenedor(tracking, importaciones) {
    const porId = {};
    (importaciones || []).forEach(i => { if (i && i.id) porId[i.id] = i; });
    const eta = tracking?.eta || null;
    const pis = (Array.isArray(tracking?.importaciones) ? tracking.importaciones : []).filter(v => v && v.id).map(v => {
      const imp = porId[v.id] || null;
      const calculada = v.llegada_calculada || null;
      return {
        vinculo: v,
        imp,
        pi: piDe(imp, v),
        descripcion: v.descripcion || null,
        llegadaCalculada: calculada,
        difDias: calculada && eta ? diasEntre(calculada, eta) : null,
        pendiente: pendienteDeImportacion(imp),
        llegada: imp ? ESTADOS_LLEGADOS.includes(imp.estado || imp.status) : false,
      };
    });
    const calculadas = [...new Set(pis.map(p => p.llegadaCalculada).filter(Boolean))].sort();
    return {
      pis,
      pendiente: r2(pis.reduce((s, p) => s + p.pendiente.monto, 0)),
      conSaldo: pis.filter(p => p.pendiente.monto > 0).length,
      calculadas,
      // Se habían calculado llegadas distintas (o distintas al arribo real) para lo que viaja junto.
      desfasadas: !!eta && pis.some(p => p.llegadaCalculada && p.llegadaCalculada !== eta),
    };
  }

  // ¿El contenedor sigue en camino? (los retirados del puerto van a "Llegados").
  function activo(t) { return (t?.estado || 'reservado') !== 'retirado'; }

  // Las navieras escriben los puertos en mayúsculas: "MONTEVIDEO" → "Montevideo".
  function nombrePuerto(s) {
    const t = String(s ?? '').trim();
    if (!t || t !== t.toUpperCase()) return t;
    return t.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (m, sep, l) => sep + l.toUpperCase());
  }

  const TrackingContenedores = {
    VALOR_LETRA, NAVIERAS, ESTADOS, TEXTO_EVENTO, ESTADOS_LLEGADOS, ESTADOS_CANCELADOS,
    normalizarContenedor, formatoContenedorValido, digitoControl, digitoControlValido, formatearContenedor,
    naviera, navieraAutomatica, linkSeguimiento,
    estadoInfo, tipoEvento, textoEvento, derivarDeEventos,
    diasEntre, progresoViaje,
    piDe, pendienteDeImportacion, resumenContenedor, activo, nombrePuerto,
  };
  raiz.TrackingContenedores = TrackingContenedores;
  if (typeof module !== 'undefined' && module.exports) module.exports = TrackingContenedores;
})(typeof window !== 'undefined' ? window : globalThis);
