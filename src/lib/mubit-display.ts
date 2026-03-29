export function formatMubitEmptyReasonLine(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length === 0) {
    return 'empty_reason=""';
  }
  return `empty_reason=${value.trim()}`;
}
