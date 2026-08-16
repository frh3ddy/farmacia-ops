import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Same-origin API prefixes the Nest server owns (kept in sync with
// apps/api/src/main.ts's apiPrefixes list) — proxied in dev so the app
// talks to the local Nest server exactly like it will in production.
const apiPrefixes = [
  "/api",
  "/admin",
  "/webhooks",
  "/locations",
  "/auth",
  "/employees",
  "/inventory",
  "/expenses",
  "/products",
  "/labor",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../api/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      apiPrefixes.map(prefix => [prefix, "http://localhost:3000"])
    ),
  },
});
