import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeInputPath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return resolve(trimmed);
}

export function normalizeProjectPath(projectPath: string): string {
  return resolve(projectPath);
}

export function normalizeProjectRoots(projectPath: string, projectPaths?: string[]): string[] {
  const out: string[] = [];
  const pushIfValid = (candidate: string): void => {
    const normalized = normalizeInputPath(candidate);
    if (!normalized) {
      return;
    }
    out.push(normalized);
  };

  pushIfValid(projectPath);
  for (const candidate of projectPaths ?? []) {
    pushIfValid(candidate);
  }

  return uniqueSorted(out);
}

export function createProjectRootsKey(projectRoots: string[]): string {
  const normalized = uniqueSorted(
    projectRoots
      .map((candidate) => normalizeInputPath(candidate))
      .filter((candidate): candidate is string => typeof candidate === "string"),
  );
  const raw = normalized.join("\n");
  return createHash("sha1").update(raw).digest("hex");
}

function pathWithinRoot(root: string, candidatePath: string): boolean {
  if (candidatePath === root) {
    return true;
  }
  return candidatePath.startsWith(`${root}${sep}`);
}

export function pathIsOwnedByProjectRoots(candidatePath: string, projectRoots: string[]): boolean {
  const normalizedCandidate = normalizeProjectPath(candidatePath);
  const normalizedRoots = uniqueSorted(
    projectRoots
      .map((candidate) => normalizeInputPath(candidate))
      .filter((candidate): candidate is string => typeof candidate === "string"),
  );
  for (const root of normalizedRoots) {
    if (pathWithinRoot(root, normalizedCandidate)) {
      return true;
    }
  }
  return false;
}

export interface ProjectRootMatcher {
  projectRoots: string[];
  projectRootsKey: string;
  ownsPath: (candidatePath: string) => boolean;
}

export function createProjectRootMatcher(projectPath: string, projectPaths?: string[]): ProjectRootMatcher {
  const projectRoots = normalizeProjectRoots(projectPath, projectPaths);
  const projectRootsKey = createProjectRootsKey(projectRoots);
  return {
    projectRoots,
    projectRootsKey,
    ownsPath: (candidatePath: string): boolean => {
      const normalizedCandidate = normalizeProjectPath(candidatePath);
      for (const root of projectRoots) {
        if (pathWithinRoot(root, normalizedCandidate)) {
          return true;
        }
      }
      return false;
    },
  };
}
