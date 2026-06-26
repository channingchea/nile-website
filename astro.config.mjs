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
});
