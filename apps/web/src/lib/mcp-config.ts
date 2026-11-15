/** Generic MCP client configuration (Streamable HTTP + bearer token). */
export function mcpConfigSnippet(origin: string, secret: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        trato: {
          type: "http",
          url: `${origin.replace(/\/+$/, "")}/mcp`,
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    },
    null,
    2,
  );
}
