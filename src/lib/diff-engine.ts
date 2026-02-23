import type { CapturedEventEnvelope } from "./core-types";

export type PatchChangeKind = "add" | "delete" | "update";

export interface FileDiffSummary {
  path: string;
  kinds: PatchChangeKind[];
  occurrences: number;
}

interface FileChangePayload {
  item?: {
    type?: string;
    changes?: Array<{
      path: string;
      kind: PatchChangeKind;
    }>;
  };
}

export function extractFileDiffs(
  events: CapturedEventEnvelope[],
  pathFilter?: string,
): FileDiffSummary[] {
  const map = new Map<string, FileDiffSummary>();

  for (const event of events) {
    const payload = event.payload as FileChangePayload;
    if (!payload?.item || payload.item.type !== "file_change" || !payload.item.changes) {
      continue;
    }

    for (const change of payload.item.changes) {
      if (pathFilter && change.path !== pathFilter) {
        continue;
      }

      const current = map.get(change.path) ?? {
        path: change.path,
        kinds: [],
        occurrences: 0,
      };
      if (!current.kinds.includes(change.kind)) {
        current.kinds.push(change.kind);
      }
      current.occurrences += 1;
      map.set(change.path, current);
    }
  }

  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
