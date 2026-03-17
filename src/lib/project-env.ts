import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface EnvLike {
  [key: string]: string | undefined;
}

function parseQuotedValue(raw: string, quote: "'" | '"'): string {
  let out = "";
  let escaped = false;

  for (let i = 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    if (quote === '"' && escaped) {
      escaped = false;
      if (char === "n") {
        out += "\n";
      } else if (char === "r") {
        out += "\r";
      } else if (char === "t") {
        out += "\t";
      } else {
        out += char;
      }
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) {
      break;
    }
    out += char;
  }

  return out;
}

function stripInlineComment(raw: string): string {
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== "#") {
      continue;
    }
    if (i === 0 || /\s/.test(raw[i - 1] ?? "")) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trim();
}

export function parseEnvFile(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  const lines = text.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eqIndex = normalized.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    const rawValue = normalized.slice(eqIndex + 1).trim();
    if (rawValue.startsWith("'")) {
      output[key] = parseQuotedValue(rawValue, "'");
      continue;
    }
    if (rawValue.startsWith('"')) {
      output[key] = parseQuotedValue(rawValue, '"');
      continue;
    }
    output[key] = stripInlineComment(rawValue);
  }

  return output;
}

export function findNearestEnvDirectory(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, ".env")) || existsSync(join(current, ".env.local"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function loadProjectEnv(startDir: string, env: EnvLike = process.env): string[] {
  const envDir = findNearestEnvDirectory(startDir);
  if (!envDir) {
    return [];
  }

  const protectedKeys = new Set(Object.keys(env));
  const loadedFiles: string[] = [];

  for (const name of [".env", ".env.local"]) {
    const path = join(envDir, name);
    if (!existsSync(path)) {
      continue;
    }

    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (protectedKeys.has(key)) {
        continue;
      }
      env[key] = value;
    }
    loadedFiles.push(path);
  }

  return loadedFiles;
}
