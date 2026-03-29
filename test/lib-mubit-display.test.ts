import { describe, expect, it } from "vitest";
import { formatMubitEmptyReasonLine } from "../src/lib/mubit-display";

describe("mubit-display", () => {
  it("preserves an explicitly empty empty_reason field", () => {
    expect(formatMubitEmptyReasonLine("")).toBe('empty_reason=""');
  });

  it("omits empty_reason when the field is absent", () => {
    expect(formatMubitEmptyReasonLine(undefined)).toBeNull();
  });

  it("formats non-empty empty_reason values", () => {
    expect(formatMubitEmptyReasonLine("recency_fallback")).toBe("empty_reason=recency_fallback");
  });
});
