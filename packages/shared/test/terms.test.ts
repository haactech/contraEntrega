import { describe, expect, it } from "vitest";
import { buildTermsSnapshot, canonicalJson, hashTerms, sha256Hex } from "../src";

const input = {
  code: "TR-0007",
  title: " Portón ",
  description: "desc",
  acceptanceCriteria: "criterios",
  buyerName: "Ana",
  totalCents: 100_000,
  advanceCents: 30_000,
  sellerDisplayName: "Juan",
  payeeAlias: "Cuenta demo 1",
  payeeLast4: "1234",
};

describe("canonicalJson", () => {
  it("is stable regardless of key order, recursively", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });
  it("drops undefined, keeps null, rejects non-finite", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe("sha256Hex / terms", () => {
  it("hashes known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("builds snapshot with computed balance and stable hash", async () => {
    const t = buildTermsSnapshot(input);
    expect(t.balanceCents).toBe(70_000);
    expect(t.title).toBe("Portón");
    expect(t.dueDate).toBeNull();
    expect(t.termsVersion).toBe(1);
    const reordered = buildTermsSnapshot({ ...input, dueDate: undefined });
    expect(await hashTerms(t)).toBe(await hashTerms(reordered));
    expect(await hashTerms(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashTerms(buildTermsSnapshot({ ...input, totalCents: 100_001 }))).not.toBe(await hashTerms(t));
  });
  it("rejects invalid split", () => {
    expect(() => buildTermsSnapshot({ ...input, advanceCents: 100_000 })).toThrow();
  });
});
