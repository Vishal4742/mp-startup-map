#!/usr/bin/env node
/*
 * Assemble the static site (map, search, filters, details — no Add/Verify)
 * into site/ for Vercel and GitHub Pages. Only the public assets and the
 * three data files (+ provenance) are copied; server, tests and tooling stay out.
 *
 *   node scripts/build-site.mjs            # -> ./site
 *   node scripts/build-site.mjs out/dir    # -> custom directory
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(ROOT, 'site');

const REQUIRED = ['index.html', 'app.js', 'style.css', 'shared/normalize.js',
  'data/tech_registry.json', 'data/enriched.json', 'data/district_coords.json'];
const OPTIONAL = ['data/registry_meta.json'];

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'data'), { recursive: true });
await mkdir(join(OUT, 'shared'), { recursive: true });
for (const f of REQUIRED) await cp(join(ROOT, f), join(OUT, f));
for (const f of OPTIONAL) {
  const exists = await stat(join(ROOT, f)).then(() => true, () => false);
  if (exists) await cp(join(ROOT, f), join(OUT, f));
}
console.log(`static site written to ${OUT}`);
