import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProviderId } from "./agent-providers";

export type ManagedHookName =
  | "post-commit"
  | "post-push"
  | "agent-complete"
  | "session-start"
  | "user-prompt-submit"
  | "pre-tool-use"
  | "session-end";

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function buildHookCommandCandidates(options: {
  hookName: ManagedHookName;
  provider?: AgentProviderId;
  scriptPath?: string | null;
  moduleUrl?: string;
}): string[] {
  const { hookName, provider, scriptPath, moduleUrl } = options;
  const out: string[] = [];
  const providerSuffix =
    hookName === "agent-complete" && provider ? ` --provider ${shellQuote(provider)}` : "";
  const normalizedScriptPath =
    typeof scriptPath === "string" && scriptPath.length > 0 && isAbsolute(scriptPath) ? scriptPath : null;
  const isLocalSourceEntry = Boolean(
    normalizedScriptPath && /(?:^|\/)(?:src\/index\.ts|dist\/index\.js)$/.test(normalizedScriptPath),
  );

  if (isLocalSourceEntry && normalizedScriptPath) {
    const codaphRoot = resolve(dirname(normalizedScriptPath), "..");
    out.push(`bun run --cwd ${shellQuote(codaphRoot)} cli hooks run ${hookName}${providerSuffix} --quiet`);
    out.push(`codaph hooks run ${hookName}${providerSuffix} --quiet`);
    return [...new Set(out)];
  }

  out.push(`codaph hooks run ${hookName}${providerSuffix} --quiet`);

  try {
    const thisFile = fileURLToPath(moduleUrl ?? import.meta.url);
    const codaphRoot = resolve(dirname(thisFile), "..");
    out.push(`bun run --cwd ${shellQuote(codaphRoot)} cli hooks run ${hookName}${providerSuffix} --quiet`);
  } catch {
    // best-effort fallback not available
  }

  return [...new Set(out)];
}
