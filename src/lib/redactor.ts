import { isObject } from "./core-types";

const REDACTED = "[REDACTED]";
const REDACTED_MUBIT_KEY = "[REDACTED_MUBIT_KEY]";
const REDACTED_API_KEY = "[REDACTED_API_KEY]";
const REDACTED_BEARER = "[REDACTED_BEARER_TOKEN]";
const REDACTED_JWT = "[REDACTED_JWT]";
const REDACTED_URL_CREDENTIAL = "[REDACTED_URL_CREDENTIAL]";

const MUBIT_KEY = /\bmbt_[A-Za-z0-9._-]{20,}\b/g;
const GENERIC_SK_KEY = /\bsk-[A-Za-z0-9._-]{20,}\b/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9._-]{16,}\b/g;
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN = /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z\-_]{20,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PEM_PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_CERT_BLOCK = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;
const AUTHORIZATION_BEARER =
  /(authorization\s*[:=]\s*(?:bearer|token)\s+)([^\s"',;]{8,})/gi;
const BASIC_AUTH_HEADER =
  /(authorization\s*[:=]\s*basic\s+)([A-Za-z0-9+/=]{8,})/gi;
const SECRET_QUERY_PARAM =
  /([?&](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password)=)([^&#\s]+)/gi;
const URL_USERINFO = /(\bhttps?:\/\/)([^\/\s:@]+):([^@\s\/]+)@/gi;
const SECRET_ASSIGNMENT =
  /(^|[\s,{([])((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|token|secret))(\s*[:=]\s*["']?)([^\s"',}\])]{6,})/gim;
const ENV_SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|REFRESH_TOKEN|SESSION_TOKEN)[A-Z0-9_]*)\s*=\s*("[^"]{4,}"|'[^']{4,}'|[^\s"']{4,})/g;
const AWS_SECRET_ACCESS_KEY_ASSIGNMENT =
  /(\baws(?:_|-)?secret(?:_|-)?access(?:_|-)?key\b\s*[:=]\s*["']?)([^\s"']{16,})/gi;
const PRIVATE_KEY_JSON_FIELD =
  /("private_key"\s*:\s*")([\s\S]*?)(")/gi;

const SENSITIVE_KEY_NAME =
  /(?:^|[_-])(api(?:[_-]?key)?|apikey|token|secret|password|passwd|pwd|authorization|auth|private(?:[_-]?key)?|client(?:[_-]?secret)?|access(?:[_-]?token)?|refresh(?:[_-]?token)?|session(?:[_-]?token)?)(?:$|[_-])/i;

function redactStringPatterns(input: string): string {
  return input
    .replace(PEM_PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY_BLOCK]")
    .replace(PEM_CERT_BLOCK, "[REDACTED_PRIVATE_KEY_BLOCK]")
    .replace(PRIVATE_KEY_JSON_FIELD, `$1[REDACTED_PRIVATE_KEY]$3`)
    .replace(MUBIT_KEY, REDACTED_MUBIT_KEY)
    .replace(ANTHROPIC_KEY, REDACTED_API_KEY)
    .replace(GENERIC_SK_KEY, REDACTED_API_KEY)
    .replace(GITHUB_PAT, REDACTED_API_KEY)
    .replace(GITHUB_TOKEN, REDACTED_API_KEY)
    .replace(GOOGLE_API_KEY, REDACTED_API_KEY)
    .replace(SLACK_TOKEN, REDACTED_API_KEY)
    .replace(AWS_ACCESS_KEY_ID, REDACTED_API_KEY)
    .replace(JWT_TOKEN, REDACTED_JWT)
    .replace(AUTHORIZATION_BEARER, (_m, prefix) => `${prefix}${REDACTED_BEARER}`)
    .replace(BASIC_AUTH_HEADER, (_m, prefix) => `${prefix}${REDACTED}`)
    .replace(SECRET_QUERY_PARAM, (_m, prefix) => `${prefix}${REDACTED}`)
    .replace(URL_USERINFO, (_m, scheme) => `${scheme}${REDACTED_URL_CREDENTIAL}:${REDACTED_URL_CREDENTIAL}@`)
    .replace(AWS_SECRET_ACCESS_KEY_ASSIGNMENT, (_m, prefix) => `${prefix}${REDACTED}`)
    .replace(ENV_SECRET_ASSIGNMENT, (_m, key) => `${key}=${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_m, leading, key, sep) => `${leading}${key}${sep}${REDACTED}`);
}

function isSensitiveKeyName(keyName: string | undefined): boolean {
  if (!keyName) {
    return false;
  }
  return SENSITIVE_KEY_NAME.test(keyName);
}

function redactUnknownInternal<T>(value: T, keyName?: string): T {
  if (typeof value === "string") {
    if (isSensitiveKeyName(keyName)) {
      return REDACTED as T;
    }
    return redactStringPatterns(value) as T;
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

export function redactSensitiveString(input: string): string {
  return redactStringPatterns(input);
}

export function redactUnknown<T>(value: T): T {
  return redactUnknownInternal(value);
}

export function redactRawLine(input: string): string {
  const trimmed = input.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
    try {
      const parsed = JSON.parse(input) as unknown;
      return JSON.stringify(redactUnknown(parsed));
    } catch {
      // fall back to string-level redaction
    }
  }
  return redactSensitiveString(input);
}
