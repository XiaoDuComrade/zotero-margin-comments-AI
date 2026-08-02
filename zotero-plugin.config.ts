import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: "build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName: `margin-comments-ai-${pkg.version}`,
  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      buildVersion: pkg.version,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        target: "firefox140",
        outfile: `build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },
});
