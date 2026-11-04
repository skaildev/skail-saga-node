/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vite dev` proxies the API to the web app (WEB_URL, default http://localhost:8080)
const web = process.env.WEB_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": web } },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
});
