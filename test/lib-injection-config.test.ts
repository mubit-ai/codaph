import { describe, expect, it } from "vitest";
import { resolveInjectionConfig, DEFAULT_INJECTION_CONFIG } from "../src/lib/injection-config";

// resolveInjectionConfig layers env over settings over defaults. These tests
// pin the env behaviour — especially CODAPH_INJECT_PHASES, which the bench uses
// to isolate one injection phase per arm — since that's the measurement gate.

describe("resolveInjectionConfig env handling", () => {
  it("defaults to disabled with no settings or env", () => {
    const cfg = resolveInjectionConfig(null, {});
    expect(cfg.enabled).toBe(false);
  });

  it("CODAPH_INJECT acts as a hard kill-switch and force-enable", () => {
    expect(resolveInjectionConfig({ enabled: true }, { CODAPH_INJECT: "0" }).enabled).toBe(false);
    expect(resolveInjectionConfig({ enabled: false }, { CODAPH_INJECT: "1" }).enabled).toBe(true);
    // unrecognized value = no opinion → settings win
    expect(resolveInjectionConfig({ enabled: true }, { CODAPH_INJECT: "maybe" }).enabled).toBe(true);
  });

  describe("CODAPH_INJECT_PHASES", () => {
    it("session arm enables only the SessionStart digest", () => {
      const cfg = resolveInjectionConfig(null, { CODAPH_INJECT_PHASES: "session" });
      expect(cfg.enabled).toBe(true);
      expect(cfg.sessionStart.enabled).toBe(true);
      expect(cfg.userPrompt.enabled).toBe(false);
      expect(cfg.preToolUse.mode).toBe("off");
    });

    it("prompt arm enables only UserPromptSubmit retrieval", () => {
      const cfg = resolveInjectionConfig(null, { CODAPH_INJECT_PHASES: "prompt" });
      expect(cfg.sessionStart.enabled).toBe(false);
      expect(cfg.userPrompt.enabled).toBe(true);
      expect(cfg.preToolUse.mode).toBe("off");
    });

    it("pretool-augment / pretool-shortcircuit select PreToolUse mode and disable others", () => {
      const augment = resolveInjectionConfig(null, { CODAPH_INJECT_PHASES: "pretool-augment" });
      expect(augment.sessionStart.enabled).toBe(false);
      expect(augment.userPrompt.enabled).toBe(false);
      expect(augment.preToolUse.mode).toBe("augment");

      const sc = resolveInjectionConfig(null, { CODAPH_INJECT_PHASES: "pretool-shortcircuit" });
      expect(sc.preToolUse.mode).toBe("shortcircuit");
    });

    it("combines tokens (session,prompt) and supports all", () => {
      const both = resolveInjectionConfig(null, { CODAPH_INJECT_PHASES: "session, prompt" });
      expect(both.sessionStart.enabled).toBe(true);
      expect(both.userPrompt.enabled).toBe(true);
      expect(both.preToolUse.mode).toBe("off");

      const all = resolveInjectionConfig(null, { CODAPH_INJECT_PHASES: "all" });
      expect(all.sessionStart.enabled).toBe(true);
      expect(all.userPrompt.enabled).toBe(true);
      expect(all.preToolUse.mode).toBe("augment");
    });

    it("off/none disables, and CODAPH_INJECT=0 still overrides phases", () => {
      expect(resolveInjectionConfig({ enabled: true }, { CODAPH_INJECT_PHASES: "off" }).enabled).toBe(false);
      const killed = resolveInjectionConfig(null, { CODAPH_INJECT_PHASES: "session", CODAPH_INJECT: "0" });
      expect(killed.enabled).toBe(false);
    });

    it("leaves config untouched when unset", () => {
      const cfg = resolveInjectionConfig({ enabled: true }, {});
      expect(cfg.sessionStart.enabled).toBe(DEFAULT_INJECTION_CONFIG.sessionStart.enabled);
      expect(cfg.preToolUse.mode).toBe(DEFAULT_INJECTION_CONFIG.preToolUse.mode);
    });
  });
});
