import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outputPath = resolve(repoRoot, "dist/index.js");
const shebang = "#!/usr/bin/env node";

if (!existsSync(outputPath)) {
  throw new Error(`Build output missing at ${outputPath}. Run bun run build first.`);
}

const original = readFileSync(outputPath, "utf8");
const withoutShebang = original.startsWith("#!") ? original.replace(/^#![^\n]*\n?/, "") : original;
const withShebang = `${shebang}\n${withoutShebang}`;

writeFileSync(outputPath, withShebang, "utf8");
chmodSync(outputPath, 0o755);
