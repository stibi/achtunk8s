import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { site } from "./src/site.ts";

export default defineConfig({
  site: site.url,
  trailingSlash: "ignore",
  build: { format: "directory" },
  integrations: [sitemap({ filter: (page) => !page.includes("/404") })],
  // The pages import the repository's own media and icon from outside this directory.
  vite: {
    server: { fs: { allow: [".."] } },
    // Never inline the page script: the Content-Security-Policy in public/_headers allows
    // scripts from this origin only, without 'unsafe-inline'.
    build: { assetsInlineLimit: 0 },
  },
});
