// @ts-check
import { defineConfig } from "astro/config";
import vue from "@astrojs/vue";
import sitemap from "@astrojs/sitemap";

// joinnile.com — static marketing site. Vue islands for interactive bits
// (waitlist modal). Sitemap integration emits sitemap.xml at build.
export default defineConfig({
  site: "https://joinnile.com",
  output: "static",
  integrations: [vue(), sitemap()],
  // VITE_CACHE_DIR lets a build redirect Vite's dep-optimizer cache off the
  // project dir (used only in sandboxed CI where the mount rejects cache
  // unlinks). Unset in normal builds → Vite's default node_modules/.vite.
  ...(process.env.VITE_CACHE_DIR
    ? { vite: { cacheDir: process.env.VITE_CACHE_DIR } }
    : {}),
});
