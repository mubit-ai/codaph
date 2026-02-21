import { contextBridge, ipcRenderer } from "electron";

const api = {
  listProjects: async () => ipcRenderer.invoke("codaph:projects:list"),
  addProject: async (projectPath?: string) =>
    ipcRenderer.invoke("codaph:projects:add", projectPath),
  removeProject: async (projectPath: string) =>
    ipcRenderer.invoke("codaph:projects:remove", projectPath),
  setLastProject: async (projectPath: string) =>
    ipcRenderer.invoke("codaph:projects:set-last", projectPath),
  getCodexAuthStatus: async () => ipcRenderer.invoke("codaph:codex:auth-status"),
  syncHistory: async (projectPath: string) =>
    ipcRenderer.invoke("codaph:history:sync", { projectPath }),
  getGitStatus: async (projectPath: string) =>
    ipcRenderer.invoke("codaph:git:status", { projectPath }),
  getGitCommits: async (projectPath: string, limit?: number) =>
    ipcRenderer.invoke("codaph:git:commits", { projectPath, limit }),
  listSessions: async (projectPath: string) =>
    ipcRenderer.invoke("codaph:sessions", { projectPath }),
  getTimeline: async (projectPath: string, sessionId: string) =>
    ipcRenderer.invoke("codaph:timeline", { projectPath, sessionId }),
  getDiff: async (projectPath: string, sessionId: string, path?: string) =>
    ipcRenderer.invoke("codaph:diff", { projectPath, sessionId, path }),
  capture: async (params: {
    projectPath: string;
    prompt: string;
    mode: "codex_sdk" | "codex_exec";
    model?: string;
    resumeThreadId?: string;
  }) => ipcRenderer.invoke("codaph:capture", params),
};

contextBridge.exposeInMainWorld("codaph", api);
