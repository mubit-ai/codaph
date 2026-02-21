/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare global {
  interface Window {
    codaph: {
      listProjects: () => Promise<{
        projects: Array<{
          path: string;
          repoId: string;
          addedAt: string;
        }>;
        lastProjectPath: string | null;
      }>;
      addProject: (projectPath?: string) => Promise<
        | {
            path: string;
            repoId: string;
            addedAt: string;
          }
        | null
      >;
      removeProject: (projectPath: string) => Promise<
        Array<{
          path: string;
          repoId: string;
          addedAt: string;
        }>
      >;
      setLastProject: (projectPath: string) => Promise<string | null>;
      getCodexAuthStatus: () => Promise<{ ok: boolean; message: string }>;
      syncHistory: (projectPath: string) => Promise<{
        scannedFiles: number;
        matchedFiles: number;
        importedEvents: number;
        importedSessions: number;
      }>;
      listSessions: (projectPath: string) => Promise<
        Array<{
          sessionId: string;
          from: string;
          to: string;
          eventCount: number;
          threadCount: number;
        }>
      >;
      getTimeline: (
        projectPath: string,
        sessionId: string,
      ) => Promise<
        Array<{
          eventId: string;
          ts: string;
          eventType: string;
          threadId: string | null;
          reasoningAvailability: "full" | "partial" | "unavailable";
          payload: Record<string, unknown>;
        }>
      >;
      getDiff: (
        projectPath: string,
        sessionId: string,
        path?: string,
      ) => Promise<
        Array<{
          path: string;
          kinds: string[];
          occurrences: number;
        }>
      >;
      capture: (params: {
        projectPath: string;
        prompt: string;
        mode: "codex_sdk" | "codex_exec";
        model?: string;
        resumeThreadId?: string;
      }) => Promise<{
        sessionId: string;
        threadId: string | null;
        finalResponse: string | null;
        eventCount: number;
        mode: "codex_sdk" | "codex_exec";
      }>;
    };
  }
}

export {};
