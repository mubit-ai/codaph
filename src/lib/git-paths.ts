import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

export type GitPathCommandRunner = (cwd: string, args: string[]) => string | null;

function defaultGitPathCommandRunner(cwd: string, args: string[]): string | null {
  try {
    const raw = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    });
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function resolveGitHooksDir(
  repoRoot: string,
  runGit: GitPathCommandRunner = defaultGitPathCommandRunner,
): string {
  const normalizedRepoRoot = resolve(repoRoot);
  const hooksPath = runGit(normalizedRepoRoot, ["rev-parse", "--git-path", "hooks"]);
  if (!hooksPath) {
    return join(normalizedRepoRoot, ".git", "hooks");
  }
  return isAbsolute(hooksPath) ? hooksPath : resolve(normalizedRepoRoot, hooksPath);
}
