<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

interface ProjectRecord {
  path: string;
  repoId: string;
  addedAt: string;
}

interface SessionSummary {
  sessionId: string;
  from: string;
  to: string;
  eventCount: number;
  threadCount: number;
}

interface EventRow {
  eventId: string;
  ts: string;
  eventType: string;
  threadId: string | null;
  reasoningAvailability: "full" | "partial" | "unavailable";
  payload: Record<string, unknown>;
}

interface DiffRow {
  path: string;
  kinds: string[];
  occurrences: number;
}

interface HistorySyncSummary {
  scannedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  importedSessions: number;
}

type CaptureMode = "codex_sdk" | "codex_exec";

const projects = ref<ProjectRecord[]>([]);
const selectedProjectPath = ref<string | null>(null);
const sessions = ref<SessionSummary[]>([]);
const selectedSessionId = ref<string | null>(null);
const events = ref<EventRow[]>([]);
const diffs = ref<DiffRow[]>([]);

const loadingProjects = ref(false);
const loadingSessions = ref(false);
const loadingTimeline = ref(false);
const syncBusy = ref(false);
const captureBusy = ref(false);

const autoSync = ref(true);
const promptInput = ref("");
const captureMode = ref<CaptureMode>("codex_exec");
const modelInput = ref("");

const status = ref<string>("");
const codexAuthMessage = ref<string>("Checking Codex login status...");
const codexAuthOk = ref<boolean>(false);

let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

const selectedProject = computed(() =>
  projects.value.find((project) => project.path === selectedProjectPath.value) ?? null,
);

const selectedSession = computed(() =>
  sessions.value.find((session) => session.sessionId === selectedSessionId.value) ?? null,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => stringFromUnknown(item))
      .filter((item): item is string => typeof item === "string" && item.length > 0);

    if (parts.length === 0) {
      return null;
    }

    return parts.join("\n");
  }

  if (isRecord(value)) {
    const candidates = [
      value.text,
      value.prompt,
      value.message,
      value.input,
      value.content,
      value.reasoning,
      value.summary,
      value.value,
      value.input_text,
      value.output_text,
    ];

    for (const candidate of candidates) {
      const text = stringFromUnknown(candidate);
      if (text) {
        return text;
      }
    }
  }

  return null;
}

function getItem(event: EventRow): Record<string, unknown> | null {
  const maybeItem = event.payload.item;
  return isRecord(maybeItem) ? maybeItem : null;
}

function getItemType(event: EventRow): string | null {
  const item = getItem(event);
  if (!item) {
    return null;
  }

  return typeof item.type === "string" ? item.type : null;
}

function getPromptText(event: EventRow): string | null {
  if (event.eventType === "prompt.submitted") {
    return stringFromUnknown(event.payload.prompt);
  }

  const item = getItem(event);
  const itemType = getItemType(event);
  if (item && (itemType === "user_message" || itemType === "input")) {
    const text =
      stringFromUnknown(item.content) ?? stringFromUnknown(item.text) ?? stringFromUnknown(item.input);
    if (text) {
      return text;
    }
  }

  if (event.eventType === "turn.started") {
    const text =
      stringFromUnknown(event.payload.prompt) ??
      stringFromUnknown(event.payload.input) ??
      stringFromUnknown(event.payload.user_input);
    if (text) {
      return text;
    }
  }

  return null;
}

function getThoughtText(event: EventRow): string | null {
  const item = getItem(event);
  const itemType = getItemType(event);
  if (itemType === "reasoning") {
    return (
      stringFromUnknown(item?.text) ??
      stringFromUnknown(item?.summary) ??
      stringFromUnknown(item?.content) ??
      "(Reasoning event without exposed text)"
    );
  }

  if (event.reasoningAvailability !== "unavailable") {
    return stringFromUnknown(item?.text) ?? "(Partial reasoning available)";
  }

  return null;
}

const promptEvents = computed(() =>
  events.value
    .map((event) => ({ event, text: getPromptText(event) }))
    .filter((row): row is { event: EventRow; text: string } => !!row.text),
);

const thoughtEvents = computed(() =>
  events.value
    .map((event) => ({ event, text: getThoughtText(event) }))
    .filter((row): row is { event: EventRow; text: string } => !!row.text),
);

const assistantOutputs = computed(() =>
  events.value
    .map((event) => {
      const item = getItem(event);
      const itemType = getItemType(event);
      if (itemType !== "agent_message") {
        return null;
      }

      const text =
        stringFromUnknown(item?.text) ?? stringFromUnknown(item?.content) ?? "(No text in response item)";
      return { event, text };
    })
    .filter((row): row is { event: EventRow; text: string } => !!row),
);

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    return ts;
  }
  return d.toLocaleString();
}

async function refreshCodexAuthStatus() {
  const auth = await window.codaph.getCodexAuthStatus();
  codexAuthOk.value = auth.ok;
  codexAuthMessage.value = auth.message;
}

async function loadProjects() {
  loadingProjects.value = true;
  try {
    const data = await window.codaph.listProjects();
    projects.value = data.projects;

    if (data.lastProjectPath && projects.value.some((project) => project.path === data.lastProjectPath)) {
      selectedProjectPath.value = data.lastProjectPath;
    } else {
      selectedProjectPath.value = projects.value[0]?.path ?? null;
    }

    if (selectedProjectPath.value) {
      await syncHistory(false, false);
      await loadSessions(selectedProjectPath.value);
    }
  } finally {
    loadingProjects.value = false;
  }
}

async function addProject() {
  const added = await window.codaph.addProject();
  if (!added) {
    return;
  }

  await loadProjects();
  selectedProjectPath.value = added.path;
  await window.codaph.setLastProject(added.path);

  await syncHistory(true, false);
  await loadSessions(added.path);
}

async function removeSelectedProject() {
  if (!selectedProjectPath.value) {
    return;
  }

  const removedPath = selectedProjectPath.value;
  await window.codaph.removeProject(removedPath);
  status.value = `Removed project ${removedPath}`;
  await loadProjects();
}

async function selectProject(projectPath: string) {
  selectedProjectPath.value = projectPath;
  await window.codaph.setLastProject(projectPath);

  await syncHistory(false, false);
  await loadSessions(projectPath);
}

async function loadSessions(projectPath: string) {
  loadingSessions.value = true;
  events.value = [];
  diffs.value = [];
  try {
    sessions.value = await window.codaph.listSessions(projectPath);
    if (sessions.value.length > 0) {
      const already = selectedSessionId.value;
      const keep = already && sessions.value.some((session) => session.sessionId === already);
      selectedSessionId.value = keep ? already : sessions.value[0].sessionId;

      if (selectedSessionId.value) {
        await loadTimeline(selectedSessionId.value);
      }
    } else {
      selectedSessionId.value = null;
    }
  } finally {
    loadingSessions.value = false;
  }
}

async function loadTimeline(sessionId: string) {
  if (!selectedProjectPath.value) {
    return;
  }

  selectedSessionId.value = sessionId;
  loadingTimeline.value = true;
  try {
    events.value = await window.codaph.getTimeline(selectedProjectPath.value, sessionId);
    diffs.value = await window.codaph.getDiff(selectedProjectPath.value, sessionId);
  } finally {
    loadingTimeline.value = false;
  }
}

async function syncHistory(manual: boolean, refreshAfterImport = true): Promise<HistorySyncSummary | null> {
  if (!selectedProjectPath.value) {
    if (manual) {
      status.value = "Choose a project folder first.";
    }
    return null;
  }

  if (syncBusy.value) {
    return null;
  }

  syncBusy.value = true;
  try {
    const summary = await window.codaph.syncHistory(selectedProjectPath.value);

    if (manual) {
      status.value = `Synced ${summary.importedEvents} events from ${summary.matchedFiles}/${summary.scannedFiles} Codex session files.`;
    } else if (summary.importedEvents > 0) {
      status.value = `Auto-sync imported ${summary.importedEvents} new events.`;
    }

    if (refreshAfterImport && summary.importedEvents > 0) {
      await loadSessions(selectedProjectPath.value);
    }

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (manual) {
      status.value = `History sync failed: ${message}`;
    }
    return null;
  } finally {
    syncBusy.value = false;
  }
}

async function runCapture() {
  if (!selectedProjectPath.value) {
    status.value = "Choose a project folder first.";
    return;
  }

  const prompt = promptInput.value.trim();
  if (!prompt) {
    status.value = "Enter a prompt to run capture.";
    return;
  }

  captureBusy.value = true;
  status.value = "Running direct Codex capture...";

  try {
    const result = await window.codaph.capture({
      projectPath: selectedProjectPath.value,
      prompt,
      mode: captureMode.value,
      model: modelInput.value.trim() || undefined,
    });

    status.value = `Captured ${result.eventCount} events in session ${result.sessionId}.`;
    promptInput.value = "";

    await loadSessions(selectedProjectPath.value);
    selectedSessionId.value = result.sessionId;
    await loadTimeline(result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.value = `Capture failed: ${message}. Use History Sync to ingest normal Codex usage.`;
  } finally {
    captureBusy.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadProjects(), refreshCodexAuthStatus()]);

  autoSyncTimer = setInterval(() => {
    if (!autoSync.value || !selectedProjectPath.value || syncBusy.value) {
      return;
    }

    void syncHistory(false);
  }, 7000);
});

onBeforeUnmount(() => {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
});
</script>

<template>
  <main class="shell">
    <aside class="rail panel">
      <div class="row-head">
        <h1>Codaph</h1>
        <button class="btn" @click="addProject">Add Folder</button>
      </div>

      <p class="hint">
        Choose one or more codebase roots. Codaph reads each folder's <code>.codaph</code> mirror.
      </p>

      <div class="project-list" v-if="projects.length > 0">
        <button
          v-for="project in projects"
          :key="project.path"
          class="project-item"
          :class="{ active: project.path === selectedProjectPath }"
          @click="selectProject(project.path)"
        >
          <span class="project-path">{{ project.path }}</span>
          <span class="mono">{{ project.repoId }}</span>
        </button>
      </div>
      <div v-else-if="loadingProjects" class="mono muted">Loading projects...</div>
      <div v-else class="mono muted">No projects yet. Click Add Folder.</div>

      <div class="row-head">
        <h2>Sessions</h2>
        <button class="btn danger" @click="removeSelectedProject" :disabled="!selectedProjectPath">
          Remove
        </button>
      </div>
      <div v-if="!selectedProjectPath" class="mono muted">Pick a project to view sessions.</div>
      <div v-else-if="loadingSessions" class="mono muted">Loading sessions...</div>
      <div v-else-if="sessions.length === 0" class="mono muted">No captured sessions yet.</div>
      <div v-else class="session-list">
        <button
          v-for="session in sessions"
          :key="session.sessionId"
          class="session-item"
          :class="{ active: session.sessionId === selectedSessionId }"
          @click="loadTimeline(session.sessionId)"
        >
          <span class="mono">{{ session.sessionId }}</span>
          <span>{{ session.eventCount }} events · {{ session.threadCount }} threads</span>
          <span class="mono muted">{{ formatTs(session.from) }}</span>
        </button>
      </div>
    </aside>

    <section class="content">
      <section class="panel capture-panel">
        <div class="row-head">
          <h2>Codex History Sync</h2>
          <span class="auth" :class="{ ok: codexAuthOk, bad: !codexAuthOk }">{{ codexAuthMessage }}</span>
        </div>

        <p class="hint">
          Keep using normal Codex CLI/Desktop. Codaph imports from <code>~/.codex/sessions</code> for the selected folder.
        </p>

        <div class="row-head control-row">
          <button class="btn primary" :disabled="syncBusy || !selectedProjectPath" @click="syncHistory(true)">
            {{ syncBusy ? "Syncing..." : "Sync Now" }}
          </button>
          <label class="toggle mono">
            <input type="checkbox" v-model="autoSync" /> Auto Sync
          </label>
        </div>

        <details class="manual-capture">
          <summary>Optional: run capture through Codaph directly</summary>

          <div class="capture-grid">
            <label>
              Adapter
              <select v-model="captureMode">
                <option value="codex_exec">codex exec --json</option>
                <option value="codex_sdk">Codex SDK</option>
              </select>
            </label>

            <label>
              Model (optional)
              <input v-model="modelInput" placeholder="o3 / gpt-5-codex" />
            </label>
          </div>

          <label>
            Prompt
            <textarea
              v-model="promptInput"
              :disabled="captureBusy"
              placeholder="Describe the task to run against the selected project"
            />
          </label>

          <div class="row-head">
            <button class="btn" :disabled="captureBusy || !selectedProjectPath" @click="runCapture">
              {{ captureBusy ? "Capturing..." : "Run Direct Capture" }}
            </button>
            <span class="mono muted">{{ selectedProject?.path ?? "No project selected" }}</span>
          </div>
        </details>

        <p class="mono status">{{ status }}</p>
      </section>

      <section class="panel" v-if="selectedSession">
        <h2>Session Snapshot</h2>
        <p class="mono">
          {{ selectedSession.sessionId }} · {{ formatTs(selectedSession.from) }} → {{ formatTs(selectedSession.to) }}
        </p>
      </section>

      <section class="panel grid-two">
        <article>
          <h3>Prompts</h3>
          <div v-if="loadingTimeline" class="mono muted">Loading timeline...</div>
          <div v-else-if="promptEvents.length === 0" class="mono muted">No prompt events detected.</div>
          <div v-else class="log-list">
            <div v-for="row in promptEvents" :key="row.event.eventId" class="log-item">
              <div class="mono muted">{{ formatTs(row.event.ts) }}</div>
              <p>{{ row.text }}</p>
            </div>
          </div>
        </article>

        <article>
          <h3>Thoughts</h3>
          <div v-if="loadingTimeline" class="mono muted">Loading timeline...</div>
          <div v-else-if="thoughtEvents.length === 0" class="mono muted">
            No reasoning text exposed by Codex in this session.
          </div>
          <div v-else class="log-list">
            <div v-for="row in thoughtEvents" :key="row.event.eventId" class="log-item">
              <div class="mono muted">
                {{ formatTs(row.event.ts) }} · {{ row.event.reasoningAvailability }}
              </div>
              <p>{{ row.text }}</p>
            </div>
          </div>
        </article>
      </section>

      <section class="panel grid-two">
        <article>
          <h3>Assistant Output</h3>
          <div v-if="assistantOutputs.length === 0" class="mono muted">
            No final assistant output events in this session.
          </div>
          <div v-else class="log-list">
            <div v-for="row in assistantOutputs" :key="row.event.eventId" class="log-item">
              <div class="mono muted">{{ formatTs(row.event.ts) }}</div>
              <p>{{ row.text }}</p>
            </div>
          </div>
        </article>

        <article>
          <h3>Diff Summary</h3>
          <div v-if="diffs.length === 0" class="mono muted">No file change events found.</div>
          <div v-else class="diff-list">
            <div v-for="diff in diffs" :key="diff.path" class="diff-item">
              <span class="mono">{{ diff.path }}</span>
              <span>{{ diff.kinds.join(", ") }} · {{ diff.occurrences }}</span>
            </div>
          </div>
        </article>
      </section>

      <section class="panel">
        <h2>Raw Timeline</h2>
        <div v-if="events.length === 0" class="mono muted">No events for this session.</div>
        <div v-else class="raw-list">
          <details v-for="event in events" :key="event.eventId" class="raw-item">
            <summary>
              <span class="mono">{{ formatTs(event.ts) }}</span>
              <strong>{{ event.eventType }}</strong>
              <span class="mono muted">{{ getItemType(event) ?? "no-item" }}</span>
            </summary>
            <pre>{{ JSON.stringify(event.payload, null, 2) }}</pre>
          </details>
        </div>
      </section>
    </section>
  </main>
</template>
