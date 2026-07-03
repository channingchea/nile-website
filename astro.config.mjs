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
  vite: {
    // Pin CSS minification to classic syntax for older iOS Safari. Without a
    // target, the minifier rewrites every `max-width`/`min-width` query to
    // Media Queries L4 range syntax (`@media (width<=480px)`), which iOS
    // Safari <16.4 doesn't parse — it drops the whole query, so all responsive
    // styles silently vanish on older iPhones.
    build: { cssTarget: ["safari13", "ios13", "chrome90", "firefox90"] },
    // VITE_CACHE_DIR redirects Vite's dep-optimizer cache off the project dir
    // (sandboxed CI where the mount rejects cache unlinks). Unset in normal
    // builds → Vite's default node_modules/.vite.
    ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
  },
});
