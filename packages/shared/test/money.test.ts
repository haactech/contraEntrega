import { describe, expect, it } from "vitest";
import { centsToMxn, checkSplit, formatMxn, mxnToCents, splitTotal } from "../src/money";

describe("centsToMxn", () => {
  it("converts", () => {
    expect(centsToMxn(123456)).toBe(1234.56);
    expect(centsToMxn(1)).toBe(0.01);
    expect(centsToMxn(0)).toBe(0);
  });
  it("rejects invalid", () => {
    expect(() => centsToMxn(1.5)).toThrow();
    expect(() => centsToMxn(-1)).toThrow();
    expect(() => centsToMxn(Number.NaN)).toThrow();
  });
});

describe("mxnToCents", () => {
  it("handles float noise", () => {
    expect(mxnToCents(0.1 + 0.2)).toBe(30);
    expect(mxnToCents(0.01)).toBe(1);
    expect(mxnToCents(1_000_000)).toBe(100_000_000);
    expect(mxnToCents(1.005 * 1)).toBe(100);
    expect(mxnToCents(102.5)).toBe(10250);
    expect(mxnToCents(19.99)).toBe(1999);
  });
  it("rejects NaN, negative, infinity", () => {
    expect(() => mxnToCents(Number.NaN)).toThrow();
    expect(() => mxnToCents(-0.01)).toThrow();
    expect(() => mxnToCents(Number.POSITIVE_INFINITY)).toThrow();
  });
  it("round-trips", () => {
    for (const c of [1, 99, 100, 12345, 100_000_000, 199_999_999]) {
      expect(mxnToCents(centsToMxn(c))).toBe(c);
    }
  });
});

describe("formatMxn", () => {
  it("formats es-MX", () => {
    expect(formatMxn(123456)).toBe("$1,234.56");
    expect(formatMxn(1)).toBe("$0.01");
    expect(formatMxn(0)).toBe("$0.00");
    expect(formatMxn(100_000_000)).toBe("$1,000,000.00");
    expect(formatMxn(5000)).toBe("$50.00");
  });
});

describe("splitTotal", () => {
  it("splits", () => {
    expect(splitTotal(100_000, 30_000)).toEqual({
      totalCents: 100_000,
      advanceCents: 30_000,
      balanceCents: 70_000,
    });
    expect(splitTotal(2, 1).balanceCents).toBe(1);
  });
  it("accepts max limits", () => {
    expect(splitTotal(200_000_000, 100_000_000).balanceCents).toBe(100_000_000);
  });
  it("rejects invalid", () => {
    expect(() => splitTotal(100, 100)).toThrow();
    expect(() => splitTotal(100, 0)).toThrow();
    expect(() => splitTotal(1, 1)).toThrow();
    expect(() => splitTotal(10.5, 1)).toThrow();
    expect(() => splitTotal(200_000_001, 100_000_000)).toThrow();
    expect(() => splitTotal(200_000_000, 99_999_999)).toThrow(); // balance > max
    expect(() => splitTotal(150_000_000, 100_000_001)).toThrow(); // advance > max
    expect(() => splitTotal(Number.MAX_SAFE_INTEGER + 2, 1)).toThrow();
  });
  it("checkSplit does not throw", () => {
    expect(checkSplit(100, 200).ok).toBe(false);
  });
});
