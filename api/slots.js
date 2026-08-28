// Calcula los turnos libres a partir del Google Calendar de Marco.
// La URL secreta iCal vive en la variable de entorno CALENDAR_ICS_URL y nunca
// llega al navegador: de cada evento solo se usan fecha y hora, jamás el título
// ni datos del paciente. Los eventos cuyo título contiene "solo online" no
// bloquean turnos: marcan franjas que se atienden únicamente por videollamada.

const ical = require('node-ical');

// Reglas de agenda (hora de Argentina, UTC-3 fijo, sin horario de verano)
const AR_OFFSET_MS = 3 * 3600 * 1000;
const SESSION_MIN = 50;
const DAYS_AHEAD = 21;
const MIN_LEAD_MS = 60 * 60 * 1000; // no ofrecer turnos con menos de 1h de aviso
// Por día de semana (0=domingo): [primer turno, último turno inclusive]
const HOURS = {
  1: [9, 20], // lunes
  2: [9, 20],
  3: [9, 20],
  4: [9, 20], // jueves
  5: [9, 15], // viernes
};

const ONLINE_MARKER = /solo\s*_?-?\s*online/i;

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// Expande un VEVENT (con o sin recurrencia) a intervalos dentro del rango.
function expandEvent(ev, rangeStart, rangeEnd) {
  const out = [];
  if (!ev.start || !ev.end) return out;
  const durationMs = ev.end.getTime() - ev.start.getTime();
  if (durationMs <= 0) return out;

  if (ev.rrule) {
    const dates = ev.rrule.between(new Date(rangeStart.getTime() - durationMs), rangeEnd, true);
    const exdates = new Set(
      Object.values(ev.exdate || {}).map((d) => new Date(d).getTime())
    );
    const overridden = new Set(Object.keys(ev.recurrences || {}));
    // rrule devuelve las repeticiones con la hora (y a veces el día) corridos
    // según la zona horaria del servidor o el TZID del evento. Como Argentina no
    // cambia de hora, cada repetición real conserva la hora UTC del primer
    // evento: reconstruimos cada instante con esa hora y elegimos el día
    // (el de la fecha cruda o sus vecinos) que quede más cerca del valor crudo.
    const refH = ev.start.getUTCHours();
    const refMin = ev.start.getUTCMinutes();
    const DAY = 24 * 3600 * 1000;
    for (const d of dates) {
      const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), refH, refMin);
      let start = base;
      for (const cand of [base - DAY, base + DAY]) {
        if (Math.abs(cand - d.getTime()) < Math.abs(start - d.getTime())) start = cand;
      }
      if (exdates.has(start)) continue;
      const dayKey = new Date(start).toISOString().substring(0, 10);
      if (overridden.has(dayKey)) continue; // esta instancia fue movida: usa la versión movida
      out.push({ start, end: start + durationMs });
    }
    // Instancias modificadas de la serie (movidas de horario)
    for (const rec of Object.values(ev.recurrences || {})) {
      if (rec.start && rec.end) {
        out.push({ start: rec.start.getTime(), end: rec.end.getTime() });
      }
    }
  } else {
    out.push({ start: ev.start.getTime(), end: ev.end.getTime() });
  }

  return out.filter((i) => i.start < rangeEnd.getTime() && i.end > rangeStart.getTime());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const icsUrl = process.env.CALENDAR_ICS_URL;
  if (!icsUrl) {
    res.status(200).json({ error: 'not_configured' });
    return;
  }

  let icsText;
  try {
    const r = await fetch(icsUrl, { headers: { 'User-Agent': 'marco-psicologo-slots' } });
    if (!r.ok) throw new Error('ics fetch ' + r.status);
    icsText = await r.text();
  } catch (e) {
    res.status(200).json({ error: 'calendar_unreachable' });
    return;
  }

  let parsed;
  try {
    parsed = ical.sync.parseICS(icsText);
  } catch (e) {
    res.status(200).json({ error: 'calendar_unreadable' });
    return;
  }

  const now = Date.now();
  const rangeStart = new Date(now - 24 * 3600 * 1000);
  const rangeEnd = new Date(now + (DAYS_AHEAD + 1) * 24 * 3600 * 1000);

  const busy = [];
  const onlineOnly = [];
  for (const ev of Object.values(parsed)) {
    if (ev.type !== 'VEVENT') continue;
    if (ev.transparency === 'TRANSPARENT') continue; // eventos marcados "Libre"
    const intervals = expandEvent(ev, rangeStart, rangeEnd);
    if (ONLINE_MARKER.test(ev.summary || '')) {
      onlineOnly.push(...intervals);
    } else {
      busy.push(...intervals);
    }
  }

  // Recorre los próximos días en hora argentina y arma los turnos libres
  const days = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const arDay = new Date(now - AR_OFFSET_MS + i * 24 * 3600 * 1000);
    const y = arDay.getUTCFullYear();
    const m = arDay.getUTCMonth();
    const d = arDay.getUTCDate();
    const dow = arDay.getUTCDay();
    const hours = HOURS[dow];
    if (!hours) continue;

    const slots = [];
    for (let h = hours[0]; h <= hours[1]; h++) {
      const start = Date.UTC(y, m, d, h) + AR_OFFSET_MS;
      const end = start + SESSION_MIN * 60 * 1000;
      if (start < now + MIN_LEAD_MS) continue;
      if (busy.some((b) => overlaps(start, end, b.start, b.end))) continue;
      const isOnline = onlineOnly.some((o) => overlaps(start, end, o.start, o.end));
      slots.push({
        time: String(h).padStart(2, '0') + ':00',
        modality: isOnline ? 'online' : 'both',
      });
    }
    if (slots.length) {
      days.push({
        date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        slots,
      });
    }
  }

  res.status(200).json({ updated: new Date(now).toISOString(), days });
};
