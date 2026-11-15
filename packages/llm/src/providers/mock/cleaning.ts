import { CLEANING_TEMPLATE } from "@trato/shared";
import { fold } from "./numbers";

/** Rule-based helpers for CLEANING (task checklist) agreements. */

export const CLEANING_RE = /\b(?:limpieza|limpiar|limpia|limpiaran|limpiara|aseo|asear)\b/;

export interface MockTask {
  title: string;
  description: string | null;
}

const T = (title: string): MockTask => {
  const t = CLEANING_TEMPLATE.tasks.find((x) => x.title === title);
  return { title, description: t?.description ?? null };
};

/** Folded keyword -> template task title. */
const KEYWORDS: Array<{ title: string; re: RegExp }> = [
  { title: "Limpiar baño", re: /\b(?:banos?|sanitarios?|wc)\b/ },
  { title: "Limpiar cocina", re: /\bcocina\b/ },
  { title: "Trapear pisos", re: /\b(?:pisos?|suelos?|trap\w*|barr\w*)\b/ },
  { title: "Limpiar ventanas", re: /\b(?:ventanas?|vidrios?|cristales)\b/ },
  { title: "Sacudir y ordenar recámara", re: /\b(?:recamaras?|cuartos?|habitacion(?:es)?|sacudir|polvo)\b/ },
  { title: "Sacar la basura", re: /\bbasura\b/ },
];

export function defaultTasks(): MockTask[] {
  return CLEANING_TEMPLATE.tasks.filter((t) => t.enabledByDefault).map((t) => T(t.title));
}

/** Template tasks mentioned in `text`, in order of first mention. */
export function mentionedTasks(text: string): MockTask[] {
  const folded = fold(text);
  return KEYWORDS.map((k) => ({ k, at: folded.search(k.re) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => T(x.k.title));
}

const ADD_RE =
  /(?:agrega(?:s|r|le|rle)?|agr[eé]gale|s[uú]ma(?:le|s|r)?|a[ñn]ade(?:s|r|le)?|a[ñn][aá]dele|incluye(?:s|r|le)?|inclúyele|ponle)\s+(?:tambi[eé]n\s+|a la lista\s+|la tarea de\s+|la tarea\s+)?([^.;!?\n]+)/g;
const REMOVE_RE = /(?:quita(?:s|r|le)?|qu[ií]tale|elimina(?:s|r|le)?|borra(?:s|r|le)?)\s+(?:la tarea de\s+|la tarea\s+|de la lista\s+)?([^.;!?\n]+)/g;

const splitParts = (s: string): string[] =>
  s
    .split(/\s*,\s*|\s+y\s+|\s+e\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

const ARTICLE = /^(?:el|la|los|las|un|una|que|tambien|también|de)\s+/;
const cleanPart = (p: string): string => p.replace(ARTICLE, "").replace(/\s+(?:por favor|porfa|tambien|también)$/, "").trim();

const titleCase = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export interface TaskOps {
  add: MockTask[];
  remove: string[]; // folded fragments / titles
}

/** «agrega X», «súmale Y», «quita Z» in a (not folded) message. */
export function parseTaskOps(text: string): TaskOps {
  const lower = text.toLowerCase();
  const add: MockTask[] = [];
  const remove: string[] = [];
  for (const m of lower.matchAll(ADD_RE)) {
    for (const part of splitParts(m[1] ?? "")) {
      const known = mentionedTasks(part);
      if (known.length > 0) {
        for (const k of known) if (!add.some((a) => a.title === k.title)) add.push(k);
      } else {
        const c = cleanPart(part);
        if (c.length >= 3 && c.length <= 60 && !/^\d/.test(c)) add.push({ title: titleCase(c), description: null });
      }
    }
  }
  for (const m of lower.matchAll(REMOVE_RE)) {
    for (const part of splitParts(m[1] ?? "")) {
      const known = mentionedTasks(part);
      if (known.length > 0) remove.push(...known.map((k) => fold(k.title)));
      else {
        const c = fold(cleanPart(part));
        if (c.length >= 3) remove.push(c);
      }
    }
  }
  return { add, remove };
}

export function applyTaskOps(base: readonly MockTask[], ops: TaskOps): { tasks: MockTask[]; added: string[]; removed: string[] } {
  let tasks = [...base];
  const removed: string[] = [];
  for (const frag of ops.remove) {
    const keep = tasks.filter((t) => !fold(t.title).includes(frag) && !frag.includes(fold(t.title)));
    for (const t of tasks) if (!keep.includes(t)) removed.push(t.title);
    tasks = keep;
  }
  const added: string[] = [];
  for (const a of ops.add) {
    if (tasks.some((t) => fold(t.title) === fold(a.title))) continue;
    tasks.push(a);
    added.push(a.title);
  }
  return { tasks, added, removed };
}
