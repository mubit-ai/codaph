import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface ProjectRegistry {
  projects: string[];
  lastProjectPath: string | null;
}

const defaultRegistry: ProjectRegistry = {
  projects: [],
  lastProjectPath: null,
};

function getRegistryPath(): string {
  return join(homedir(), ".codaph", "projects.json");
}

async function writeRegistry(registry: ProjectRegistry): Promise<ProjectRegistry> {
  const path = getRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}

export async function loadRegistry(): Promise<ProjectRegistry> {
  try {
    const raw = await readFile(getRegistryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectRegistry>;
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => resolve(entry))
      : [];

    const uniqueProjects = [...new Set(projects)];
    const lastProjectPath =
      typeof parsed.lastProjectPath === "string" && parsed.lastProjectPath.trim().length > 0
        ? resolve(parsed.lastProjectPath)
        : null;

    if (uniqueProjects.length === 0) {
      return { ...defaultRegistry };
    }

    return {
      projects: uniqueProjects,
      lastProjectPath:
        lastProjectPath && uniqueProjects.includes(lastProjectPath)
          ? lastProjectPath
          : uniqueProjects[0],
    };
  } catch {
    return { ...defaultRegistry };
  }
}

export async function addProjectToRegistry(projectPath: string): Promise<ProjectRegistry> {
  const registry = await loadRegistry();
  const normalized = resolve(projectPath);

  if (!registry.projects.includes(normalized)) {
    registry.projects.unshift(normalized);
  }
  registry.lastProjectPath = normalized;
  return writeRegistry(registry);
}

export async function removeProjectFromRegistry(projectPath: string): Promise<ProjectRegistry> {
  const registry = await loadRegistry();
  const normalized = resolve(projectPath);
  registry.projects = registry.projects.filter((project) => project !== normalized);
  if (registry.lastProjectPath === normalized) {
    registry.lastProjectPath = registry.projects[0] ?? null;
  }
  return writeRegistry(registry);
}

export async function setLastProject(projectPath: string): Promise<ProjectRegistry> {
  const registry = await loadRegistry();
  const normalized = resolve(projectPath);
  if (!registry.projects.includes(normalized)) {
    registry.projects.unshift(normalized);
  }
  registry.lastProjectPath = normalized;
  return writeRegistry(registry);
}
