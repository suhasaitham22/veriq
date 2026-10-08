import { build } from "esbuild";
// Local compilation only: no Cloudflare API calls or deployment operations.
await build({ entryPoints: ["apps/api/src/index.ts"], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: "dist/api.js" });
await build({ entryPoints: ["apps/web/_worker.js"], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: "dist/pages-worker.js" });
console.log("Compiled API and Pages proxy locally.");
