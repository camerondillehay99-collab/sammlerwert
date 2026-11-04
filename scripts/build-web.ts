#!/usr/bin/env bun
// Bundles the SPA into web/public/assets with content hashes and writes index.html from the template.
import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../server/config.ts";

const root = new URL("../web/", import.meta.url).pathname;
const out = join(root, "public", "assets");
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });

const watch = process.argv.includes("--watch");
async function build() {
  const t0 = performance.now();
  const res = await Bun.build({
    entrypoints: [join(root, "src", "main.ts")],
    outdir: out,
    target: "browser",
    format: "esm",
    minify: !watch,
    sourcemap: watch ? "inline" : "none",
    naming: "app.[hash].js",
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  });
  if (!res.success) { for (const l of res.logs) console.error(l); if (!watch) process.exit(1); return; }
  const js = res.outputs.find((o) => o.path.endsWith(".js"))!;
  const css = await Bun.file(join(root, "styles", "app.css")).text();
  const hash = Bun.hash(css).toString(16).slice(0, 10);
  const cssName = `app.${hash}.css`;
  await Bun.write(join(out, cssName), css);
  for (const f of readdirSync(out)) if (f.endsWith(".js") && f !== js.path.split("/").pop()) rmSync(join(out, f));
  for (const f of readdirSync(out)) if (f.endsWith(".css") && f !== cssName) rmSync(join(out, f));
  const html = (await Bun.file(join(root, "index.html")).text())
    .replaceAll("__BRAND__", config.brand.name).replaceAll("__TAGLINE__", config.brand.tagline)
    .replace("__JS__", js.path.split("/").pop()!).replace("__CSS__", cssName);
  await Bun.write(join(root, "public", "index.html"), html);
  console.log(`web gebaut: ${js.path.split("/").pop()} (${(js.size / 1024).toFixed(1)} kB), ${cssName} (${(css.length / 1024).toFixed(1)} kB) in ${(performance.now() - t0).toFixed(0)} ms`);
}
await build();
if (watch) {
  const { watch: fsWatch } = await import("node:fs");
  let t: ReturnType<typeof setTimeout>;
  for (const dir of ["src", "styles", "."]) fsWatch(join(root, dir), { recursive: dir === "src" }, () => { clearTimeout(t); t = setTimeout(build, 80); });
  console.log("beobachte web/ …");
}
