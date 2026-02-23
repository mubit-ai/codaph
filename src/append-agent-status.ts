import { appendSnapshotToAgentMd, collectSnapshot } from "./agent-status";

function parseSourceArg(argv: string[]): "manual" | "pre-commit" {
  const idx = argv.indexOf("--source");
  if (idx !== -1) {
    const val = argv[idx + 1];
    if (val === "pre-commit") {
      return "pre-commit";
    }
  }
  return "manual";
}

async function main(): Promise<void> {
  const source = parseSourceArg(process.argv.slice(2));
  const snapshot = await collectSnapshot(source);
  await appendSnapshotToAgentMd(snapshot);
  console.log(`Appended AGENT.md snapshot (${source}) at ${snapshot.ts}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
