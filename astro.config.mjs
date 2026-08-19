// @ts-check
import { defineConfig } from "astro/config";
import vue from "@astrojs/vue";
import sitemap from "@astrojs/sitemap";

// joinnile.com — static marketing site. Vue islands for interactive bits
// (waitlist modal). Sitemap integration emits sitemap.xml at build.
export default defineConfig({
  site: "https://joinnile.com",
  output: "static",
  // Keep every page that carries a <meta name="robots" content="noindex">
  // tag out of the sitemap too — submitting a page you've told Google not to
  // index sends a mixed signal. /download is noindex until the Mac app
  // clears internal testing; drop it from this list when the page goes into
  // the nav (and remove its noindex tag at the same time).
  integrations: [
    vue(),
    sitemap({
      filter: (page) =>
        ![
          "/auth/",
          "/download",
          "/admin",
          "/advertise/portal",
          "/boost",
          "/tip",
          "/tip-success",
        ].some((noindexPath) => page.includes(noindexPath)),
    }),
  ],
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
