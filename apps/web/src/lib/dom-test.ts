import { act } from "react";

/** Test helpers for React-controlled inputs (no testing-library in this package). */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("elemento no encontrado");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function byText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string | RegExp): T | null {
  return (
    ([...root.querySelectorAll<T>(selector)].find((e) =>
      typeof text === "string" ? (e.textContent ?? "").trim().includes(text) : text.test(e.textContent ?? ""),
    ) as T | undefined) ?? null
  );
}
