/**
 * Spanish (Mexico) number and money parsing for the rule-based mock. Pure, no dependencies.
 * Everything works on *folded* text (lowercase, accents removed, same length as the input).
 */

/** Lowercase + strip accents while keeping string length (NFC in, NFC-equivalent out). */
export function fold(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[áàä]/g, "a")
    .replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u")
    .replace(/ñ/g, "n");
}

/** Replaces [start, end) with spaces (keeps indices stable for later passes). */
export function maskSpan(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

const WORD_VALUES: Record<string, number> = {
  cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28,
  veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80,
  noventa: 90, cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600,
  seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
};

const isMagnitude = (w: string): boolean => w === "mil" || w === "millon" || w === "millones";
const isNumberWord = (w: string): boolean => w in WORD_VALUES || isMagnitude(w);

/** Value of a run of number words («veinte mil quinientos» -> 20500), or null. */
export function wordsToNumber(words: readonly string[]): number | null {
  let total = 0;
  let cur = 0;
  let any = false;
  for (const w of words) {
    if (w === "y") continue;
    if (w === "mil") {
      total += (cur || 1) * 1000;
      cur = 0;
    } else if (w === "millon" || w === "millones") {
      total += (cur || 1) * 1_000_000;
      cur = 0;
    } else {
      const v = WORD_VALUES[w];
      if (v === undefined) return null;
      cur += v;
    }
    any = true;
  }
  return any ? total + cur : null;
}

export interface WordRun {
  start: number;
  end: number;
  words: string[];
  value: number;
}

/** Maximal runs of number words in folded text. A lone «un/una/uno» is not a run. */
export function findNumberWordRuns(folded: string): WordRun[] {
  const runs: WordRun[] = [];
  const re = /[a-z]+/g;
  let cur: { start: number; end: number; words: string[] } | null = null;
  let pendingY: { word: string; end: number } | null = null;
  const flush = () => {
    if (cur) {
      const first = cur.words[0];
      const lone = cur.words.length === 1 && (first === "un" || first === "una" || first === "uno");
      const value = wordsToNumber(cur.words);
      if (value !== null && !lone) runs.push({ ...cur, value });
    }
    cur = null;
    pendingY = null;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    const w = m[0];
    const start = m.index;
    const end = start + w.length;
    // Only whitespace between tokens keeps a run alive.
    if (cur && /[^\s]/.test(folded.slice(cur.end, start)) && !pendingY) flush();
    if (cur && pendingY && /[^\s]/.test(folded.slice(pendingY.end, start))) flush();
    if (w === "y" && cur) {
      pendingY = { word: w, end };
      continue;
    }
    if (isNumberWord(w)) {
      if (cur) {
        cur.words.push(...(pendingY ? ["y"] : []), w);
        cur.end = end;
      } else {
        cur = { start, end, words: [w] };
      }
      pendingY = null;
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

/* ------------------------------------------------------------------ money */

export interface MoneyMention {
  kind: "money";
  start: number;
  end: number;
  cents: number;
}

export interface FractionMention {
  kind: "fraction";
  start: number;
  end: number;
  num: number;
  den: number;
}

export type AmountMention = MoneyMention | FractionMention;

const CURRENCY = "(?:pesos|peso|varos|baros|lana|feria|mxn|mdp|m\\.n\\.)";
const UNIT_AFTER =
  /^\s*(?:piezas?|pzas?|metros?|mts?|m2|cm|kg|kilos?|litros?|lts?|horas?|hrs?|dias?|semanas?|meses|mes|ventanas?|puertas?|sillas?|mesas?|unidades|veces|años?|anos?|personas?|%|por\s*ciento|porciento|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)|\/)/;

/** Parses «20,000.50», «20.000,50», «20 000», «20000», «2.5» into a decimal string "20000.50". */
export function normalizeDigits(raw: string): string {
  const s = raw.replace(/\s+/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let intPart = s;
  let frac = "";
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = Math.max(lastComma, lastDot);
    intPart = s.slice(0, dec);
    frac = s.slice(dec + 1);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const idx = s.lastIndexOf(sep);
    const tail = s.slice(idx + 1);
    const count = s.split(sep).length - 1;
    // «20,000» / «1.500» / «1,500,000» are thousands separators; «250.50» / «2,5» are decimals.
    if (count > 1 || tail.length === 3) {
      intPart = s;
    } else {
      intPart = s.slice(0, idx);
      frac = tail;
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

function centsFrom(decimal: string, multiplier: number): number {
  const v = Number(decimal);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * multiplier * 100);
}

const SUFFIX_MULT: Array<[RegExp, number]> = [
  [/^\s*(?:millon|millones)\b/, 1_000_000],
  [/^\s*mil\b/, 1000],
  [/^\s*lucas?\b/, 1000],
  [/^\s*k\b/, 1000],
];

/** Money mentions written with digits, number words or slang («20 lucas»). */
export function findMoneyMentions(folded: string): MoneyMention[] {
  const out: MoneyMention[] = [];

  // digits
  const digitRe = new RegExp(
    String.raw`(\$\s*)?(\d{1,3}(?:[ ,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?)`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = digitRe.exec(folded)) !== null) {
    const hasDollar = Boolean(m[1]);
    const numStr = m[2] ?? "";
    let end = m.index + m[0].length;
    let mult = 1;
    let suffixed = false;
    const rest = folded.slice(end);
    for (const [re, mul] of SUFFIX_MULT) {
      const sm = re.exec(rest);
      if (sm) {
        mult = mul;
        end += sm[0].length;
        suffixed = true;
        break;
      }
    }
    const curRe = new RegExp(`^\\s*${CURRENCY}(?![a-z])`);
    const cm = curRe.exec(folded.slice(end));
    if (cm) end += cm[0].length;
    const decimal = normalizeDigits(numStr);
    const base = Number(decimal);
    if (!Number.isFinite(base)) continue;
    const before = folded[m.index - 1];
    if (before === "/" || before === "-" || (before !== undefined && /[a-z0-9]/.test(before))) continue;
    const accept =
      hasDollar ||
      suffixed ||
      Boolean(cm) ||
      (base >= 100 && !UNIT_AFTER.test(folded.slice(end)) && folded[end] !== "/");
    if (!accept) continue;
    out.push({ kind: "money", start: m.index, end, cents: centsFrom(decimal, mult) });
  }

  // number words
  for (const run of findNumberWordRuns(folded)) {
    const mentionsMagnitude = run.words.some(isMagnitude);
    const curRe = new RegExp(`^\\s*${CURRENCY}(?![a-z])`);
    const cm = curRe.exec(folded.slice(run.end));
    const bigEnough = run.value >= 100;
    if (!mentionsMagnitude && !cm && !(bigEnough && !UNIT_AFTER.test(folded.slice(run.end)))) continue;
    const end = run.end + (cm ? cm[0].length : 0);
    // «mil pesos» alone is 1000; «mil quinientos» is 1500: handled by wordsToNumber.
    out.push({ kind: "money", start: run.start, end, cents: Math.round(run.value * 100) });
  }

  // drop mentions contained in another (digits parsed inside a word-run, etc.)
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: MoneyMention[] = [];
  for (const mm of out) {
    const last = kept[kept.length - 1];
    if (last && mm.start < last.end) continue;
    kept.push(mm);
  }
  return kept;
}

/** «la mitad», «30 %», «un tercio», «70/30» as fractions of the total. */
export function findFractionMentions(folded: string): FractionMention[] {
  const out: FractionMention[] = [];
  const push = (m: RegExpExecArray, num: number, den: number) =>
    out.push({ kind: "fraction", start: m.index, end: m.index + m[0].length, num, den });

  const pct = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|por\s*ciento|porciento)/g;
  let m: RegExpExecArray | null;
  while ((m = pct.exec(folded)) !== null) {
    const n = Number((m[1] ?? "").replace(",", "."));
    if (Number.isFinite(n) && n > 0 && n < 100) push(m, Math.round(n * 100), 10_000);
  }
  const words: Array<[RegExp, number, number]> = [
    [/\b(?:la\s+)?mitad\b/g, 1, 2],
    [/\b(?:un|el)\s+tercio\b|\buna\s+tercera\s+parte\b/g, 1, 3],
    [/\bdos\s+terceras\s+partes\b|\bdos\s+tercios\b/g, 2, 3],
    [/\b(?:un|el)\s+cuarto\b|\buna\s+cuarta\s+parte\b/g, 1, 4],
    [/\btres\s+cuartos\b|\btres\s+cuartas\s+partes\b/g, 3, 4],
  ];
  for (const [re, n, d] of words) {
    while ((m = re.exec(folded)) !== null) push(m, n, d);
  }
  const split = /\b(\d{2})\s*[/-]\s*(\d{2})\b/g;
  while ((m = split.exec(folded)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a + b === 100) push(m, a, 100);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
