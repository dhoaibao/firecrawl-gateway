import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Static output only: the site is built to plain files and served by nginx.
export default defineConfig({
  output: "static",
  vite: { plugins: [tailwindcss()] },
});
