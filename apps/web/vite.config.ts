import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    // react-router v8 expects React 19 exports; bundle it through Vite so tests render with React 18.
    server: { deps: { inline: [/react-router/] } },
  },
});
