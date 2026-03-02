import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export type GitCommandRunner = (cwd: string, args: string[]) => string | null;

function defaultGitCommandRunner(cwd: string, args: string[]): string | null {
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

function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function parseGitWorktreeListPorcelain(raw: string): string[] {
  const out: string[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const pathValue = line.slice("worktree ".length).trim();
    if (pathValue.length === 0) {
      continue;
    }
    out.push(resolve(pathValue));
  }
  return dedupePreserveOrder(out);
}

export function scopeProjectPathAcrossWorktrees(
  worktreeRoots: string[],
  repoRoot: string,
  projectPath: string,
): string[] {
  const normalizedRepoRoot = resolve(repoRoot);
  const normalizedProjectPath = resolve(projectPath);
  const relativeSuffix = relative(normalizedRepoRoot, normalizedProjectPath);
  if (relativeSuffix.startsWith("..") || isAbsolute(relativeSuffix)) {
    return [normalizedProjectPath];
  }

  const scoped = worktreeRoots.map((worktreeRoot) =>
    relativeSuffix.length === 0 ? resolve(worktreeRoot) : resolve(worktreeRoot, relativeSuffix)
  );
  const normalizedScoped = dedupePreserveOrder(scoped);
  if (!normalizedScoped.includes(normalizedProjectPath)) {
    normalizedScoped.unshift(normalizedProjectPath);
  }
  return normalizedScoped;
}

export function resolveScopedProjectPathsForWorktrees(
  projectPath: string,
  runGit: GitCommandRunner = defaultGitCommandRunner,
): string[] {
  const normalizedProjectPath = resolve(projectPath);
  const repoRootRaw = runGit(normalizedProjectPath, ["rev-parse", "--show-toplevel"]);
  if (!repoRootRaw) {
    return [normalizedProjectPath];
  }
  const repoRoot = resolve(repoRootRaw);
  const worktreeListRaw = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!worktreeListRaw) {
    return [normalizedProjectPath];
  }
  const worktreeRoots = parseGitWorktreeListPorcelain(worktreeListRaw);
  if (worktreeRoots.length === 0) {
    return [normalizedProjectPath];
  }
  return scopeProjectPathAcrossWorktrees(worktreeRoots, repoRoot, normalizedProjectPath);
}
