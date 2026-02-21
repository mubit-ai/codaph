import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function gitRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

async function main(): Promise<void> {
  const root = gitRoot();
  const hooksDir = join(root, ".git", "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  await mkdir(hooksDir, { recursive: true });
  const content = `#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
bun run agent:status -- --source pre-commit
git add AGENT.md
`;

  await writeFile(hookPath, content, "utf8");
  await chmod(hookPath, 0o755);

  console.log(`Installed pre-commit hook at ${hookPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
