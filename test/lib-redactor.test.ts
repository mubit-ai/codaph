import { describe, expect, it } from "vitest";
import { redactRawLine, redactSensitiveString, redactUnknown } from "../src/lib/redactor";

describe("redactor", () => {
  it("redacts common provider/api tokens in strings", () => {
    const text = [
      "mbt_mubit-dev-1_ovr38uk1bb4johkn_qHLXEni8HpwL4JgVDunPZ7ZfPFWeuLK3AjfZO4oIafUx3ZL0fyegjVefSwsKPBVi",
      "sk-123456789012345678901234567890",
      "sk-ant-api03-123456789012345678901234567890",
      "github_pat_11ABCDEF123456789012345678901234567890",
      "ghp_123456789012345678901234567890123456",
      "AIzaSyD12345678901234567890123456789012345",
    ].join(" ");

    const redacted = redactSensitiveString(text);
    expect(redacted).not.toMatch(/mbt_mubit-dev/i);
    expect(redacted).not.toMatch(/\bsk-/);
    expect(redacted).not.toMatch(/github_pat_/);
    expect(redacted).not.toMatch(/\bghp_/);
    expect(redacted).not.toMatch(/\bAIza/);
    expect(redacted).toContain("[REDACTED");
  });

  it("redacts auth headers, query params, and URL credentials", () => {
    const text =
      'Authorization: Bearer super_secret_token_123456 https://user:pass@example.com?a=1&api_key=xyz_secret_12345';
    const out = redactSensitiveString(text);
    expect(out).toContain("[REDACTED_BEARER_TOKEN]");
    expect(out).not.toContain("super_secret_token_123456");
    expect(out).toContain("[REDACTED_URL_CREDENTIAL]");
    expect(out).not.toContain("user:pass@");
    expect(out).not.toContain("xyz_secret_12345");
  });

  it("redacts nested secret fields but keeps non-secret keys like tokenEstimate", () => {
    const payload = {
      tokenEstimate: "24k",
      apiKey: "should_hide",
      nested: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      },
    };
    const out = redactUnknown(payload);
    expect(out.tokenEstimate).toBe("24k");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(String(out.nested.authorization)).toContain("[REDACTED]");
    expect(out.nested.private_key).toBe("[REDACTED]");
  });

  it("redacts raw json lines by parsing and sanitizing values", () => {
    const line = JSON.stringify({
      type: "assistant",
      tokenEstimate: "24k",
      apiKey: "sk-123456789012345678901234567890",
      nested: { token: "abc123456789secret" },
    });
    const out = redactRawLine(line);
    expect(out).not.toContain("sk-1234567890");
    expect(out).not.toContain("abc123456789secret");
    expect(out).toContain("\"tokenEstimate\":\"24k\"");
  });
});
