import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  base: "./",
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, "../dist/renderer"),
    emptyOutDir: true,
  },
});
