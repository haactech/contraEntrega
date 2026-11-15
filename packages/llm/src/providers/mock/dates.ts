import { findNumberWordRuns } from "./numbers";

/** Relative/absolute Spanish date resolution against a fixed «today» (YYYY-MM-DD). Pure. */

export interface DateMention {
  start: number;
  end: number;
  /** YYYY-MM-DD */
  date: string;
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const WEEKDAYS: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};
const MONTH_RE = Object.keys(MONTHS).join("|");
const WEEKDAY_RE = Object.keys(WEEKDAYS).join("|");

interface Ymd {
  y: number;
  m: number;
  d: number;
}

export function parseYmd(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const fmt = ({ y, m, d }: Ymd): string =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const toUtc = ({ y, m, d }: Ymd): number => Date.UTC(y, m - 1, d);
const fromUtc = (ms: number): Ymd => {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};

export const weekdayOf = (ymd: Ymd): number => new Date(toUtc(ymd)).getUTCDay();
export const addDays = (ymd: Ymd, n: number): Ymd => fromUtc(toUtc(ymd) + n * 86_400_000);
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addMonths(ymd: Ymd, n: number): Ymd {
  const idx = ymd.y * 12 + (ymd.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { y, m, d: Math.min(ymd.d, daysInMonth(y, m)) };
}

function validYmd({ y, m, d }: Ymd): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Next occurrence of (month, day) on or after `today`; rolls to next year when already past. */
function nextMonthDay(today: Ymd, m: number, d: number): Ymd | null {
  let cand: Ymd = { y: today.y, m, d };
  if (!validYmd(cand)) return null;
  if (toUtc(cand) < toUtc(today)) {
    cand = { y: today.y + 1, m, d };
    if (!validYmd(cand)) return null;
  }
  return cand;
}

const SMALL_WORDS: Record<string, number> = { un: 1, una: 1, medio: 0 };

function parseCount(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (token in SMALL_WORDS) return SMALL_WORDS[token] ?? null;
  const run = findNumberWordRuns(token)[0];
  if (run && run.start === 0 && run.end === token.length) return run.value;
  return null;
}

/**
 * All date expressions in `folded`, in text order. «El viernes» is the next Friday strictly after
 * today (on a Friday it means next week's). Returns [] when nothing resolvable is found.
 */
export function findDateMentions(folded: string, todayStr: string): DateMention[] {
  const today = parseYmd(todayStr);
  if (!today) return [];
  const out: DateMention[] = [];
  const add = (m: RegExpExecArray, ymd: Ymd | null) => {
    if (ymd) out.push({ start: m.index, end: m.index + m[0].length, date: fmt(ymd) });
  };
  let m: RegExpExecArray | null;

  // ISO
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(folded)) !== null) {
    const ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    add(m, validYmd(ymd) ? ymd : null);
  }

  // «15 de diciembre», «3 de enero de 2027», «el 15 diciembre»
  const dm = new RegExp(String.raw`\b(\d{1,2})\s*(?:de\s+)?(${MONTH_RE})(?:\s*(?:de|del)?\s*(\d{4}))?\b`, "g");
  while ((m = dm.exec(folded)) !== null) {
    const d = Number(m[1]);
    const mo = MONTHS[m[2] ?? ""] ?? 0;
    const explicitYear = m[3] ? Number(m[3]) : null;
    add(m, explicitYear ? { y: explicitYear, m: mo, d } : nextMonthDay(today, mo, d));
    const last = out[out.length - 1];
    if (last && explicitYear && !validYmd({ y: explicitYear, m: mo, d })) out.pop();
  }

  // dd/mm[/yyyy]
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  while ((m = slash.exec(folded)) !== null) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) continue;
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const ymd = { y, m: mo, d };
      add(m, validYmd(ymd) ? ymd : null);
    } else {
      add(m, nextMonthDay(today, mo, d));
    }
  }

  // pasado mañana / mañana / hoy
  const pm = /\bpasado\s+manana\b/g;
  while ((m = pm.exec(folded)) !== null) add(m, addDays(today, 2));
  const tomorrow = /\bmanana\b/g;
  while ((m = tomorrow.exec(folded)) !== null) {
    const before = folded.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:pasado|la|esta|en la|por la|de la)\s*$/.test(before)) continue;
    add(m, addDays(today, 1));
  }
  const todayRe = /\b(?:para|entrego|entregar|termino|terminar|listo)\s+hoy\b|\bhoy\s+mismo\b/g;
  while ((m = todayRe.exec(folded)) !== null) add(m, today);

  // weekdays
  const wd = new RegExp(
    String.raw`\b(?:el\s+|este\s+|para\s+el\s+)?(?:proximo\s+)?(${WEEKDAY_RE})(?:\s+(?:que\s+viene|proximo|siguiente))?\b`,
    "g",
  );
  while ((m = wd.exec(folded)) !== null) {
    if (/^\s*(?:pasado|anterior)\b/.test(folded.slice(m.index + m[0].length))) continue;
    const target = WEEKDAYS[m[1] ?? ""];
    if (target === undefined) continue;
    let delta = (target - weekdayOf(today) + 7) % 7;
    if (delta === 0) delta = 7;
    add(m, addDays(today, delta));
  }

  // «en 2 semanas», «dentro de quince días», «en un mes», «en una quincena»
  const rel = /\b(?:en|dentro\s+de)\s+([a-z0-9]+(?:\s+(?:y\s+)?[a-z]+)?)\s+(dias?|semanas?|meses|mes|quincenas?)\b/g;
  while ((m = rel.exec(folded)) !== null) {
    const raw = (m[1] ?? "").trim();
    let n = parseCount(raw);
    if (n === null) {
      // take the first token that parses («dos semanas»: regex may have captured extra words)
      n = parseCount(raw.split(/\s+/)[0] ?? "");
    }
    if (n === null || n <= 0) continue;
    const unit = m[2] ?? "";
    let ymd: Ymd;
    if (unit.startsWith("dia")) ymd = addDays(today, n);
    else if (unit.startsWith("semana")) ymd = addDays(today, 7 * n);
    else if (unit.startsWith("quincena")) ymd = addDays(today, 15 * n);
    else ymd = addMonths(today, n);
    add(m, ymd);
  }

  // «a fin de mes», «a finales de mes»
  const eom = /\ba\s+fin(?:es|al)?\s+de\s+mes\b/g;
  while ((m = eom.exec(folded)) !== null) {
    const last = { y: today.y, m: today.m, d: daysInMonth(today.y, today.m) };
    add(m, last);
  }

  // «el día 20», «para el 20» (day of month, no month name)
  const dayOnly = /\b(?:para\s+el|el\s+dia|dia)\s+(\d{1,2})\b(?!\s*(?:de\b|mil\b|k\b|%|\/|[.,]\d))/g;
  while ((m = dayOnly.exec(folded)) !== null) {
    const d = Number(m[1]);
    if (d < 1 || d > 31) continue;
    let cand: Ymd = { y: today.y, m: today.m, d };
    if (!validYmd(cand) || d <= today.d) {
      const next = addMonths({ y: today.y, m: today.m, d: 1 }, 1);
      cand = { y: next.y, m: next.m, d };
    }
    add(m, validYmd(cand) ? cand : null);
  }

  // drop mentions that overlap an earlier (longer) one
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: DateMention[] = [];
  for (const d of out) {
    const last = kept[kept.length - 1];
    if (last && d.start < last.end) continue;
    kept.push(d);
  }
  return kept;
}

const WEEKDAY_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTH_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
  "noviembre", "diciembre",
];

/** «viernes 20 de noviembre». */
export function dateEs(date: string): string {
  const ymd = parseYmd(date);
  if (!ymd) return date;
  return `${WEEKDAY_ES[weekdayOf(ymd)]} ${ymd.d} de ${MONTH_ES[ymd.m - 1]}`;
}
