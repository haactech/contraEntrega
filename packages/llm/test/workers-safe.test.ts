import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** `src/` runs in Cloudflare Workers: no Node APIs (the eval runner in `evals/` may use them). */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("src/ es compatible con Workers", () => {
  const src = files(join(__dirname, "..", "src"));
  it("no importa módulos de Node ni usa process/Buffer/require", () => {
    expect(src.length).toBeGreaterThan(5);
    for (const f of src) {
      const code = readFileSync(f, "utf8");
      expect(code, f).not.toMatch(/from\s+["']node:/);
      expect(code, f).not.toMatch(/\bprocess\.(env|argv|exit)/);
      expect(code, f).not.toMatch(/\bBuffer\b/);
      expect(code, f).not.toMatch(/\brequire\(/);
    }
  });
});
