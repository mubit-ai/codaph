import { mubitRunIdForProject, mubitRunIdForSession } from "./memory-mubit";
import type { MubitRunScope } from "../settings-store";

export function resolveMubitCommandRunId(options: {
  repoId: string;
  projectId?: string | null;
  runScope: MubitRunScope;
  sessionId?: string | null;
  preferProject?: boolean;
  runIdPrefix?: string;
}): string {
  const projectId = options.projectId ?? options.repoId;
  if (options.preferProject) {
    return mubitRunIdForProject(projectId, options.runIdPrefix);
  }
  if (options.sessionId) {
    return mubitRunIdForSession(projectId, options.sessionId, options.runIdPrefix);
  }
  return mubitRunIdForProject(projectId, options.runIdPrefix);
}
