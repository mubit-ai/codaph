import { describe, expect, it } from "vitest";
import { redactSensitiveString, redactUnknown } from "../src/lib/security";

describe("security redaction", () => {
  it("redacts mubit keys and generic keys", () => {
    const text = "token=mbt_mubit-dev-1_ovr38uk1bb4johkn_qHLXEni8HpwL4JgVDunPZ7ZfPFWeuLK3AjfZO4oIafUx3ZL0fyegjVefSwsKPBVi and sk-12345678901234567890";
    const redacted = redactSensitiveString(text);
    expect(redacted).not.toContain("mbt_mubit-dev-1");
    expect(redacted).not.toContain("sk-1234567890");
    expect(redacted).toContain("[REDACTED");
  });

  it("redacts nested object values", () => {
    const payload = {
      apiKey: "abc",
      nested: {
        token: "secret_token_value_123456",
      },
    };

    const out = redactUnknown(payload);
    expect(String(out.nested.token)).toContain("[REDACTED]");
  });
});
