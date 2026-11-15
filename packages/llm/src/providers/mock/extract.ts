import { findDateMentions } from "./dates";
import {
  findFractionMentions,
  findMoneyMentions,
  fold,
  maskSpan,
  type AmountMention,
  type FractionMention,
  type MoneyMention,
} from "./numbers";

/** Rule-based term extraction from one human message (Spanish, Mexico). */

export interface Draft {
  title: string | null;
  description: string | null;
  acceptanceCriteria: string | null;
  totalCents: number | null;
  advanceCents: number | null;
  dueDate: string | null;
  buyerName: string | null;
}

export const EMPTY_DRAFT: Draft = {
  title: null,
  description: null,
  acceptanceCriteria: null,
  totalCents: null,
  advanceCents: null,
  dueDate: null,
  buyerName: null,
};

export interface ExtractNotes {
  /** Two different totals with no correction wording: do not guess. */
  ambiguousTotal: boolean;
  ambiguousAdvance: boolean;
  /** A percentage/fraction was given but no total is known. */
  fractionWithoutTotal: boolean;
  /** Several amounts without any role words: the advance is not guessed. */
  unlabeledAmounts: boolean;
}

export interface ExtractContext {
  /** Total already known from the open proposal or earlier messages. */
  baseTotalCents: number | null;
  /** There is a proposal/terms being revised (unlabeled single amount means the total). */
  revising: boolean;
  /** What the last Trato message asked for, if it was a clarification. */
  askedFor: "advance" | "total" | null;
  /** Allow guessing a title from a message that starts with a noun phrase. */
  allowNounTitle: boolean;
}

type Role = "adv" | "bal" | "tot";

const ROLE_KEYWORDS: Array<{ role: Role; re: RegExp }> = [
  {
    role: "adv",
    re: /\b(?:anticip\w*|antisip\w*|adelant\w*|enganche|para (?:empezar|arrancar|iniciar|comenzar|apartar)|de entrada|primer pago|primera parte|al (?:inicio|empezar|arrancar|iniciar|comenzar)|por adelantado|ahorita|apartado|abono)\b/g,
  },
  {
    role: "bal",
    re: /\b(?:resto|saldo|restante|lo demas|al (?:terminar|entregar|finalizar|final|instalar\w*|recibir)|contra ?entrega|a la entrega|cuando (?:termine|quede|entregue|este listo)|liquid\w*)\b/g,
  },
  {
    role: "tot",
    re: /\b(?:total|cobro|cobrar|cuesta\w*|sale en|me sale|precio|vale|costo|presupuesto|cotizacion|son|serian|seria|en todo|por todo|todo incluido|con todo y|mano de obra)\b/g,
  },
];

const CORRECTION_RE = /\b(?:mejor|perdon|digo|corrijo|en realidad|ya mejor|cambio|cambia|ahora si)\b/;

/** Clause boundaries (indices) so a keyword only labels amounts in its own clause. */
function clauseBounds(folded: string): number[] {
  const out = [0];
  const re = /[;!?\n]|\.(?=\s|$)|,\s| y | pero | luego | despues /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) out.push(m.index + (m[0].length > 1 ? 1 : 0));
  out.push(folded.length + 1);
  return out;
}

const clauseOf = (bounds: number[], idx: number): number => {
  let c = 0;
  for (let i = 0; i < bounds.length - 1; i++) if (idx >= (bounds[i] ?? 0)) c = i;
  return c;
};

const gap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  aEnd <= bStart ? bStart - aEnd : aStart >= bEnd ? aStart - bEnd : 0;

function assignRoles(folded: string, mentions: AmountMention[]): Array<Role | null> {
  const bounds = clauseBounds(folded);
  const best: Array<{ role: Role; dist: number } | null> = mentions.map(() => null);
  for (const { role, re } of ROLE_KEYWORDS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(folded)) !== null) {
      const ks = m.index;
      const ke = ks + m[0].length;
      const kc = clauseOf(bounds, ks);
      let nearest = -1;
      let nd = Infinity;
      mentions.forEach((mm, i) => {
        if (clauseOf(bounds, mm.start) !== kc) return;
        const d = gap(ks, ke, mm.start, mm.end);
        if (d < nd) {
          nd = d;
          nearest = i;
        }
      });
      if (nearest >= 0) {
        const cur = best[nearest];
        if (!cur || nd < cur.dist) best[nearest] = { role, dist: nd };
      }
    }
  }
  return best.map((b) => b?.role ?? null);
}

const isMoney = (m: AmountMention): m is MoneyMention => m.kind === "money";
const isFraction = (m: AmountMention): m is FractionMention => m.kind === "fraction";

const fractionCents = (total: number, f: FractionMention): number => Math.round((total * f.num) / f.den);

/* ------------------------------------------------------------------ names */

const NOT_NAMES = new Set([
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo", "hoy", "manana", "navidad",
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
  "noviembre", "diciembre", "trato", "comprador", "prestador", "cliente", "ahorita", "empezar", "mi", "mis",
]);

const NAME_RE =
  /\b(?:para|cliente|comprador|a nombre de)\s*:?\s+(?:(?:el|la)\s+)?(?:(?:sr|sra|srita|senor|senora|don|dona|doctor|doctora|dr|dra|ing|lic|arq)\.?\s+)?([A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+(?:(?:de|del|de la)\s+)?[A-ZÁÉÍÓÚÑ][\p{L}'-]+){0,2})/gu;

export function findBuyerName(text: string): string | null {
  const nfc = text.normalize("NFC");
  const re = new RegExp(NAME_RE.source, NAME_RE.flags);
  let m: RegExpExecArray | null;
  let found: string | null = null;
  while ((m = re.exec(nfc)) !== null) {
    const name = (m[1] ?? "").trim();
    const first = fold(name.split(/\s+/)[0] ?? "");
    if (NOT_NAMES.has(first)) continue;
    found = name;
  }
  return found;
}

/* ------------------------------------------------------------- work phrase */

const VERBS: Record<string, string> = {
  hacer: "Hacer", hago: "Hacer", pintar: "Pintar", pinto: "Pintar", instalar: "Instalar", instalo: "Instalar",
  arreglar: "Arreglar", arreglo: "Arreglar", cambiar: "Cambiar", cambio: "Cambiar", fabricar: "Fabricar",
  fabrico: "Fabricar", construir: "Construir", construyo: "Construir", disenar: "Diseñar", diseno: "Diseñar",
  reparar: "Reparar", reparo: "Reparar", coser: "Coser", coso: "Coser", cortar: "Cortar", montar: "Montar",
  monto: "Montar", colocar: "Colocar", coloco: "Colocar", armar: "Armar", armo: "Armar", elaborar: "Elaborar",
  elaboro: "Elaborar", soldar: "Soldar", soldo: "Soldar", tapizar: "Tapizar", tapizo: "Tapizar",
  rebobinar: "Rebobinar", rebobino: "Rebobinar", cablear: "Cablear", cableo: "Cablear", reemplazar: "Reemplazar",
  reemplazo: "Reemplazar", restaurar: "Restaurar", restauro: "Restaurar", barnizar: "Barnizar",
  barnizo: "Barnizar", impermeabilizar: "Impermeabilizar", impermeabilizo: "Impermeabilizar",
  destapar: "Destapar", destapo: "Destapar", afinar: "Afinar", afino: "Afinar", confeccionar: "Confeccionar",
  confecciono: "Confeccionar", bordar: "Bordar", bordo: "Bordar", ajustar: "Ajustar", ajusto: "Ajustar",
  lijar: "Lijar", lijo: "Lijar", rehacer: "Rehacer", rehago: "Rehacer", forjar: "Forjar", forjo: "Forjar",
  fabricarle: "Fabricar", hacerle: "Hacer", pintarle: "Pintar", instalarle: "Instalar", arreglarle: "Arreglar",
};
const VERB_RE = new RegExp(
  String.raw`\b(${Object.keys(VERBS).join("|")})\s+(?:te\s+|le\s+|les\s+)?(.+)`,
);
const TRAILING_CONNECTORS = /\s+(?:de|por|en|a|el|la|los|las|para|son|cuesta|cobro|total|y|con|al|del|que|es|sale|serian|seria)$/;

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Cuts `text` at the first of `cuts` (indices), at the first « para <Name>» / comma, and trims. */
function cutObject(orig: string, folded: string, startIdx: number, cuts: number[]): string {
  let end = orig.length;
  for (const c of cuts) if (c > startIdx && c < end) end = c;
  let seg = orig.slice(startIdx, end);
  const f = folded.slice(startIdx, end);
  const stop = /,\s|;|\.(?=\s|$)|\s+para\s|\s+por\s+(?=\d|\$|[a-z]+\s+mil)| y el resto| y luego/.exec(f);
  if (stop) seg = seg.slice(0, stop.index);
  seg = seg.trim().replace(/[\s,.;:]+$/, "");
  for (let i = 0; i < 3; i++) {
    const t = seg.replace(TRAILING_CONNECTORS, "");
    if (t === seg) break;
    seg = t;
  }
  return seg.slice(0, 70).trim();
}

const NOUN_TITLE_STOP = /^(?:son|es|pues|ok|si|sale|mejor|hola|buenas|buenos|oye|bueno|gracias|claro|perfecto|listo|ya|no|sera|seria|me|te|mi|mis|el|la|los|las|un|una|cuanto|cuando|quien|como|que|por)\b/;

/** Title + description + criteria from the text; empty patch when no job is described. */
function extractWork(
  orig: string,
  folded: string,
  cuts: number[],
  allowNoun: boolean,
): Pick<Draft, "title" | "description" | "acceptanceCriteria"> {
  const empty = { title: null, description: null, acceptanceCriteria: null };
  const vm = VERB_RE.exec(folded);
  let title: string | null = null;
  let object = "";
  if (vm) {
    const verb = vm[1] ?? "";
    const objStart = folded.indexOf(vm[2] ?? "", vm.index + verb.length);
    object = cutObject(orig, folded, objStart, cuts);
    if (object.length >= 2) title = `${VERBS[verb] ?? cap(verb)} ${object}`;
  } else if (allowNoun) {
    const cand = cutObject(orig, folded, 0, cuts);
    const fc = fold(cand);
    if (cand.length >= 4 && !NOUN_TITLE_STOP.test(fc) && /^[a-zñ]/.test(fc) && !/\b(?:anticipo|total|mitad)\b/.test(fc)) {
      title = cap(cand);
      object = cand;
    }
  }
  if (!title) return empty;
  const includes = /\b(?:incluye\w*|con todo y|con material\w*|con instalacion|con pintura|material incluido)\b[^,.;]*/i.exec(orig);
  const installs = /\binstal/.test(folded);
  const criteria =
    `${cap(object)} terminado${installs ? " e instalado" : ""} y entregado al comprador, con fotos de la entrega.` +
    (includes ? ` Incluye: ${includes[0].trim()}.` : "");
  return { title: title.slice(0, 80), description: includes ? includes[0].trim() : "", acceptanceCriteria: criteria };
}

/* ------------------------------------------------------------------ main */

export function extractFromText(
  text: string,
  today: string,
  ctx: ExtractContext,
): { patch: Partial<Draft>; notes: ExtractNotes; found: boolean } {
  const orig = text.normalize("NFC");
  const folded = fold(orig);
  const notes: ExtractNotes = {
    ambiguousTotal: false,
    ambiguousAdvance: false,
    fractionWithoutTotal: false,
    unlabeledAmounts: false,
  };
  const patch: Partial<Draft> = {};

  // dates first so their digits are never read as money
  const dates = findDateMentions(folded, today);
  let masked = folded;
  for (const d of dates) masked = maskSpan(masked, d.start, d.end);
  const lastDate = dates[dates.length - 1];
  if (lastDate) patch.dueDate = lastDate.date;

  const fractions = findFractionMentions(masked);
  for (const f of fractions) masked = maskSpan(masked, f.start, f.end);
  const money = findMoneyMentions(masked);
  const mentions: AmountMention[] = [...money, ...fractions].sort((a, b) => a.start - b.start);

  const roles = assignRoles(folded, mentions);
  const correction = CORRECTION_RE.test(folded);

  const byRole = (role: Role | "none") =>
    mentions
      .map((m, i) => ({ m, role: roles[i] ?? null }))
      .filter((x) => (role === "none" ? x.role === null : x.role === role));
  const moneyOf = (role: Role | "none") => byRole(role).map((x) => x.m).filter(isMoney);
  const fracOf = (role: Role | "none") => byRole(role).map((x) => x.m).filter(isFraction);
  const lastOf = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];
  const distinct = (xs: MoneyMention[]) => new Set(xs.map((x) => x.cents)).size;

  // ---- total
  const totM = moneyOf("tot");
  const advM = moneyOf("adv");
  const balM = moneyOf("bal");
  const noneM = moneyOf("none");
  let total: number | null = null;
  let advance: number | null = null;

  if (totM.length > 0) {
    if (distinct(totM) > 1 && !correction) notes.ambiguousTotal = true;
    else total = lastOf(totM)?.cents ?? null;
  } else if (advM.length > 0 && balM.length > 0) {
    total = (lastOf(advM)?.cents ?? 0) + (lastOf(balM)?.cents ?? 0);
  }

  // ---- unlabeled amounts
  if (total === null && !notes.ambiguousTotal && noneM.length > 0) {
    const biggest = noneM.reduce((a, b) => (b.cents > a.cents ? b : a));
    if (advM.length > 0 || balM.length > 0) {
      total = biggest.cents;
    } else if (ctx.baseTotalCents !== null && !ctx.revising && ctx.askedFor === "advance" && noneM.length === 1) {
      advance = noneM[0]?.cents ?? null;
    } else if (noneM.length === 1) {
      total = noneM[0]?.cents ?? null;
    } else if (distinct(noneM) > 1 && !correction) {
      notes.unlabeledAmounts = true;
      total = biggest.cents;
    } else {
      total = lastOf(noneM)?.cents ?? null;
    }
  }
  const totalEff = total ?? ctx.baseTotalCents;

  // ---- advance
  if (advance === null) {
    if (advM.length > 0) {
      if (distinct(advM) > 1 && !correction) notes.ambiguousAdvance = true;
      else advance = lastOf(advM)?.cents ?? null;
    } else {
      const fAdv = fracOf("adv")[0] ?? fracOf("none")[0];
      const fBal = fracOf("bal")[0];
      if (fAdv) {
        if (totalEff === null) notes.fractionWithoutTotal = true;
        else advance = fractionCents(totalEff, fAdv);
      } else if (balM.length > 0 && totalEff !== null) {
        advance = totalEff - (lastOf(balM)?.cents ?? 0);
      } else if (fBal) {
        if (totalEff === null) notes.fractionWithoutTotal = true;
        else advance = totalEff - fractionCents(totalEff, fBal);
      }
    }
  }
  if (total !== null) patch.totalCents = total;
  if (advance !== null) patch.advanceCents = advance;

  // ---- buyer + work
  const name = findBuyerName(orig);
  if (name) patch.buyerName = name;
  const cuts = [...mentions.map((m) => m.start), ...dates.map((d) => d.start)];
  const work = ctx.revising
    ? { title: null, description: null, acceptanceCriteria: null }
    : extractWork(orig, folded, cuts, ctx.allowNounTitle);
  if (work.title) {
    patch.title = work.title;
    if (work.description !== null) patch.description = work.description;
    if (work.acceptanceCriteria) patch.acceptanceCriteria = work.acceptanceCriteria;
  }

  const found = Object.keys(patch).length > 0 || mentions.length > 0 || Object.values(notes).some(Boolean);
  return { patch, notes, found };
}
