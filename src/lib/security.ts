import { isObject } from "./core-types";

const MUBIT_KEY = /mbt_[A-Za-z0-9_-]{20,}/g;
const GENERIC_API_KEY = /sk-[A-Za-z0-9_-]{20,}/g;
const KV_SECRET = /(api[_-]?key|token|secret)(\s*[:=]\s*["']?)([^\s"']{8,})/gi;
const SECRET_KEY_NAME = /(api[_-]?key|token|secret)/i;

export function redactSensitiveString(input: string): string {
  return input
    .replace(MUBIT_KEY, "[REDACTED_MUBIT_KEY]")
    .replace(GENERIC_API_KEY, "[REDACTED_API_KEY]")
    .replace(KV_SECRET, (_m, k, sep) => `${k}${sep}[REDACTED]`);
}

function redactUnknownInternal<T>(value: T, keyName?: string): T {
  if (typeof value === "string") {
    if (keyName && SECRET_KEY_NAME.test(keyName)) {
      return "[REDACTED]" as T;
    }
    return redactSensitiveString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknownInternal(item, keyName)) as T;
  }

  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactUnknownInternal(v, k);
    }
    return out as T;
  }

  return value;
}

export function redactUnknown<T>(value: T): T {
  return redactUnknownInternal(value);
}
