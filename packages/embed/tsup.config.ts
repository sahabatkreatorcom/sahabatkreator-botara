import { defineConfig } from "tsup";

// Widget webchat: dibundel menjadi SATU file IIFE mandiri `dist/widget.js`
// (vanilla, tanpa framework) yang dipasang situs tenant lewat <script>.
export default defineConfig({
  entry: ["src/widget.ts"],
  format: ["iife"],
  outDir: "dist",
  clean: true,
  minify: true,
  outExtension: () => ({ js: ".js" }),
});
