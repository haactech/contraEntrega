import { describe, expect, it } from "vitest";
import { mcpConfigSnippet } from "./mcp-config";

describe("mcpConfigSnippet", () => {
  it("points at <origin>/mcp with a bearer header", () => {
    const cfg = JSON.parse(mcpConfigSnippet("https://trato.example/", "trk_secret")) as {
      mcpServers: { trato: { url: string; headers: Record<string, string> } };
    };
    expect(cfg.mcpServers.trato.url).toBe("https://trato.example/mcp");
    expect(cfg.mcpServers.trato.headers["Authorization"]).toBe("Bearer trk_secret");
  });
});
