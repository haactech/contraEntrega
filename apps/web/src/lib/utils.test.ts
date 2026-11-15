import { describe, expect, it } from "vitest";
import { centsToInputValue, parseMxnToCents, percentOfCents } from "./money";
import { fitWithin } from "./image";
import { POLL_FAST_MS, POLL_SLOW_MS, formatCountdown, pollInterval, secondsUntil } from "./polling";
import { eventText } from "./events";
import { computeProgress } from "./progress";

describe("parseMxnToCents", () => {
  it.each([
    ["1234", 123400],
    ["1,234.50", 123450],
    ["$800", 80000],
    ["0.1", 10],
    ["0.07", 7],
    [".5", 50],
    ["19.99", 1999],
    ["1.005", null],
    ["", null],
    ["abc", null],
    ["-5", null],
    ["1e3", null],
    ["12.", 1200],
  ])("%j -> %j", (input, expected) => {
    expect(parseMxnToCents(input)).toBe(expected);
  });

  it("avoids floating point errors (e.g. 1.15 * 100)", () => {
    expect(parseMxnToCents("1.15")).toBe(115);
    expect(parseMxnToCents("8.2")).toBe(820);
    expect(parseMxnToCents("4.35")).toBe(435);
  });

  it("round-trips through centsToInputValue", () => {
    for (const c of [1, 10, 99, 100, 12345, 123450]) {
      expect(parseMxnToCents(centsToInputValue(c))).toBe(c);
    }
  });
});

describe("percentOfCents", () => {
  it("computes presets as integers", () => {
    expect(percentOfCents(100000, 30)).toBe(30000);
    expect(percentOfCents(99999, 50)).toBe(50000);
    expect(Number.isInteger(percentOfCents(33333, 70))).toBe(true);
  });
});

describe("fitWithin", () => {
  it("does not upscale", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it("scales landscape to 1600 wide", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
  });
  it("scales portrait to 1600 tall", () => {
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
  });
  it("respects a custom max and never returns 0", () => {
    expect(fitWithin(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });
  it("rejects invalid dimensions", () => {
    expect(() => fitWithin(0, 10)).toThrow();
  });
});

describe("pollInterval", () => {
  it("is 3 s with a pending payment, 15 s otherwise, paused when hidden", () => {
    expect(pollInterval({ awaitingPayment: true, hidden: false })).toBe(POLL_FAST_MS);
    expect(pollInterval({ awaitingPayment: false, hidden: false })).toBe(POLL_SLOW_MS);
    expect(pollInterval({ awaitingPayment: true, hidden: true })).toBeNull();
    expect(pollInterval({ awaitingPayment: false, hidden: true })).toBeNull();
    expect(POLL_FAST_MS).toBe(3000);
    expect(POLL_SLOW_MS).toBe(15000);
  });
});

describe("countdown", () => {
  it("computes seconds and clamps at zero", () => {
    const now = Date.parse("2026-11-14T12:00:00.000Z");
    expect(secondsUntil("2026-11-14T12:01:30.000Z", now)).toBe(90);
    expect(secondsUntil("2026-11-14T11:00:00.000Z", now)).toBe(0);
    expect(secondsUntil(null, now)).toBeNull();
  });
  it("formats", () => {
    expect(formatCountdown(125)).toBe("02:05");
    expect(formatCountdown(3700)).toBe("1:01:40");
    expect(formatCountdown(-3)).toBe("00:00");
  });
});

describe("eventText microcopy", () => {
  const milestones = [
    { id: "m1", kind: "ADVANCE", amountCents: 100, description: "", status: "PAID", deliveryRound: 0, approvedAt: null, paidAt: null },
    { id: "m2", kind: "BALANCE", amountCents: 100, description: "", status: "PAID", deliveryRound: 0, approvedAt: null, paidAt: null },
  ] as const;

  it("distinguishes acceptance from advance received", () => {
    const accepted = eventText({ type: "TERMS_ACCEPTED", payload: {} });
    const advance = eventText({ type: "PAYMENT_CONFIRMED", payload: { milestoneId: "m1" } }, milestones);
    expect(accepted.title).toBe("Acuerdo aceptado");
    expect(advance.title).toBe("Anticipo recibido");
    expect(accepted.title).not.toBe(advance.title);
  });

  it("distinguishes request sent from payment confirmed", () => {
    const sent = eventText({ type: "PAYMENT_REQUEST_CREATED", payload: {} });
    expect(sent.title).toBe("Solicitud enviada");
    expect(sent.title).not.toMatch(/confirmado|pagado|recibido/i);
  });

  it("distinguishes work received from balance paid", () => {
    const approved = eventText({ type: "DELIVERY_APPROVED", payload: {} });
    const balance = eventText({ type: "PAYMENT_CONFIRMED", payload: { milestoneKind: "BALANCE", amountCents: 50000 } });
    expect(approved.title).toBe("Trabajo recibido");
    expect(balance.title).toBe("Saldo pagado");
    expect(balance.detail).toBe("$500.00");
  });

  it("falls back to a neutral payment title when the milestone is unknown", () => {
    expect(eventText({ type: "PAYMENT_CONFIRMED", payload: {} }).title).toBe("Pago confirmado");
  });

  it("shows the dispute comment", () => {
    expect(eventText({ type: "DELIVERY_DISPUTED", payload: { comment: "Falta una pieza" } }).detail).toBe("Falta una pieza");
  });
});

describe("computeProgress", () => {
  const base = { status: "SHARED", sharedAt: "x", buyerAcceptedAt: null } as const;
  it("walks through the steps", () => {
    expect(computeProgress({ agreement: { status: "DRAFT", sharedAt: null, buyerAcceptedAt: null }, milestones: [] }).current).toBe(0);
    expect(computeProgress({ agreement: base, milestones: [] }).current).toBe(1);
    expect(
      computeProgress({
        agreement: { ...base, buyerAcceptedAt: "y" },
        milestones: [{ kind: "ADVANCE", status: "ELIGIBLE" }],
      }).current,
    ).toBe(2);
    const paid = { ...base, status: "IN_PROGRESS", buyerAcceptedAt: "y" } as const;
    const adv = { kind: "ADVANCE", status: "PAID" } as const;
    expect(computeProgress({ agreement: paid, milestones: [adv, { kind: "BALANCE", status: "WAITING_DELIVERY" }] }).current).toBe(3);
    expect(computeProgress({ agreement: paid, milestones: [adv, { kind: "BALANCE", status: "DISPUTED" }] }).current).toBe(4);
    expect(computeProgress({ agreement: paid, milestones: [adv, { kind: "BALANCE", status: "READY_TO_CHARGE" }] }).current).toBe(5);
    expect(computeProgress({ agreement: { ...paid, status: "COMPLETED" }, milestones: [adv, { kind: "BALANCE", status: "PAID" }] }).done).toBe(true);
  });
});
