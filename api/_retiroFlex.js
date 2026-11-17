// api/_retiroFlex.js
// El retiro de GestionPost ($75, el toggle "Se cobra retiro" del envío).
//
// GestionPost pasa a buscar los paquetes una vez por jornada. Si en la jornada hay menos de
// 3 envíos, cobra el retiro en cada uno; con 3 o más, no cobra ninguno. La jornada va de un
// horario de corte al siguiente, en hora de Montevideo:
//
//   lunes a viernes  corte 16:00   (la del lunes arranca el domingo a las 14:00)
//   sábado           corte 13:00   (arranca el viernes a las 16:00)
//   domingo          corte 14:00   (arranca el sábado a las 13:00)
//
// Un envío creado a las 15:59 sale ese día; uno de las 16:00 en adelante, en la jornada
// siguiente. El momento que cuenta es el `created_at` del envío, que es cuando entró la venta.
//
// Se recalcula la jornada entera cada vez que cambia su cantidad de envíos (se crea uno, se
// borra o se cambia de transportista), así que el tercer envío les apaga el retiro a los dos
// primeros. Prender o apagar el toggle a mano no dispara el recálculo: queda como se dejó
// hasta que la jornada vuelva a cambiar.

'use strict';

const ZONA = 'America/Montevideo';
const TRANSPORTISTA_RETIRO = 'gestionpost';
const MINIMO_SIN_RETIRO = 3;
// Hora de corte por día de la semana (0 = domingo … 6 = sábado).
const HORA_CORTE = { 0: 14, 1: 16, 2: 16, 3: 16, 4: 16, 5: 16, 6: 13 };

const fmtPartes = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Año, mes, día, hora y minuto de ese instante en Montevideo.
function partesUY(instante) {
  const p = {};
  for (const { type, value } of fmtPartes.formatToParts(instante)) p[type] = Number(value);
  return p;
}

// El instante en que en Montevideo es ese día a esa hora en punto. `dia` es 'YYYY-MM-DD'.
function instanteUY(dia, hora) {
  const [y, m, d] = dia.split('-').map(Number);
  const supuesto = Date.UTC(y, m - 1, d, hora);
  // Lo que marca el reloj de Montevideo en ese instante UTC: la diferencia es el huso.
  const p = partesUY(new Date(supuesto));
  const visto = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(supuesto - (visto - supuesto));
}

function sumarDias(dia, n) {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const diaSemana = dia => new Date(`${dia}T12:00:00Z`).getUTCDay();
const horaCorte = dia => HORA_CORTE[diaSemana(dia)];

/**
 * La jornada de despacho a la que pertenece un instante: el día en que sale el paquete
 * (`dia`, 'YYYY-MM-DD') y el intervalo [desde, hasta) de envíos que entran en ella.
 */
function jornadaDe(instante = new Date()) {
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida para la jornada: ${instante}`);
  const p = partesUY(d);
  const hoy = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const dia = p.hour < horaCorte(hoy) ? hoy : sumarDias(hoy, 1);
  const anterior = sumarDias(dia, -1);
  return {
    dia,
    desde: instanteUY(anterior, horaCorte(anterior)).toISOString(),
    hasta: instanteUY(dia, horaCorte(dia)).toISOString(),
  };
}

/**
 * Vuelve a contar los envíos de GestionPost de la jornada de `instante` y deja el retiro
 * prendido en todos (si son menos de 3) o apagado en todos (si son 3 o más).
 */
async function recalcularRetiro(supabase, instante = new Date()) {
  const jornada = jornadaDe(instante);
  const { data, error } = await supabase
    .from('envios')
    .select('id, colecta')
    .eq('transportista', TRANSPORTISTA_RETIRO)
    .gte('created_at', jornada.desde)
    .lt('created_at', jornada.hasta);
  if (error) throw new Error(`Error leyendo los envíos de la jornada ${jornada.dia}: ${error.message}`);

  const envios = data || [];
  const retiro = envios.length > 0 && envios.length < MINIMO_SIN_RETIRO;
  const cambiados = envios.filter(e => !!e.colecta !== retiro).map(e => e.id);
  if (cambiados.length) {
    const { error: updErr } = await supabase.from('envios').update({ colecta: retiro }).in('id', cambiados);
    if (updErr) throw new Error(`Error actualizando el retiro de la jornada ${jornada.dia}: ${updErr.message}`);
  }
  return { ...jornada, envios: envios.length, retiro, cambiados };
}

// Lo mismo, sin cortar a quien lo llama: un error acá no puede hacer perder una venta ni
// un envío. Devuelve null si no se pudo.
async function recalcularRetiroSeguro(supabase, instante = new Date()) {
  try {
    const r = await recalcularRetiro(supabase, instante);
    if (r.cambiados.length) {
      console.log(`🚚 Retiro jornada ${r.dia}: ${r.envios} envío(s) de GestionPost → retiro ${r.retiro ? 'prendido' : 'apagado'} en ${r.cambiados.length}`);
    }
    return r;
  } catch (e) {
    console.error('❌ No se pudo recalcular el retiro de GestionPost:', e.message);
    return null;
  }
}

module.exports = {
  jornadaDe,
  recalcularRetiro,
  recalcularRetiroSeguro,
  TRANSPORTISTA_RETIRO,
  MINIMO_SIN_RETIRO,
  HORA_CORTE,
};
