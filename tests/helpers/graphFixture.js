// One graph holding every shape the live graph was found to contain (spec:
// "What the live graph holds"), as plain migration records. A fresh copy on
// every call, so a test may mutate what it gets.
export const FIXTURE_PROJECT = "github.com/acme/app";
const OTHER = "github.com/acme/other";

// Neo4j prints this instant as 2026-07-22T13:32:22.78Z: a dropped trailing zero.
export const FIXTURE_TIME = Date.UTC(2026, 6, 22, 13, 32, 22, 780);
const T = FIXTURE_TIME;
const P = FIXTURE_PROJECT;

// Every project the fixture uses; "" is the global scope.
export const FIXTURE_PROJECTS = ["", P, OTHER];

export function fixtureRecords() {
  return {
    entities: [
      { name: "decision:storage-layout", project: P, type: "decision", createdAt: T, updatedAt: T + 86_400_000 },
      { name: "ticket:APP-1", project: P, type: null, createdAt: T + 1, updatedAt: null },
      // No observations: created by a relation alone.
      { name: "service:billing", project: P, type: "service", createdAt: T + 2, updatedAt: null },
      // Global entity.
      { name: "user", project: "", type: "person", createdAt: T + 3, updatedAt: null },
      // Same name, different project.
      { name: "decision:storage-layout", project: OTHER, type: "decision", createdAt: T + 4, updatedAt: null },
    ],
    sessions: [
      { id: "sess-1", cwd: "/repo", project: P, startedAt: T - 60_000 },
      { id: "sess-2", cwd: null, project: null, startedAt: T - 30_000 },
    ],
    observations: [
      // obs-1..3 share one timestamp, as a write batch does.
      { id: "obs-1", entityName: "decision:storage-layout", entityProject: P, text: "line one\tcol\nline two", subsystem: "storage", sessionId: "sess-1", createdAt: T, seq: 101 },
      { id: "obs-2", entityName: "decision:storage-layout", entityProject: P, text: "second in the batch", subsystem: null, sessionId: "sess-1", createdAt: T, seq: 102 },
      { id: "obs-3", entityName: "decision:storage-layout", entityProject: P, text: "third in the batch", subsystem: "storage", sessionId: "sess-1", createdAt: T, seq: 103 },
      // A session id with no Session node; an astral-plane character.
      { id: "obs-4", entityName: "ticket:APP-1", entityProject: P, text: "deploy 🚀 done", subsystem: "deploy", sessionId: "sess-missing", createdAt: T + 10, seq: 104 },
      // Imported by migrate-claude-mem, which marks its observations with a source.
      { id: "obs-5", entityName: "user", entityProject: "", text: "prefers pnpm", subsystem: null, source: "claude-mem", sessionId: null, createdAt: T + 20, seq: 105 },
      { id: "obs-6", entityName: "decision:storage-layout", entityProject: OTHER, text: 'path C:\\temp and "quotes"', subsystem: null, sessionId: "sess-2", createdAt: T + 30, seq: 106 },
    ],
    relations: [
      { fromName: "decision:storage-layout", fromProject: P, type: "implements", toName: "ticket:APP-1", toProject: P, createdAt: T + 5 },
      // No createdAt.
      { fromName: "ticket:APP-1", fromProject: P, type: "depends-on", toName: "service:billing", toProject: P, createdAt: null },
      // Self-reference.
      { fromName: "decision:storage-layout", fromProject: P, type: "see-also", toName: "decision:storage-layout", toProject: P, createdAt: T + 6 },
    ],
    sessionLinks: [
      { sessionId: "sess-1", observationId: "obs-1" },
      { sessionId: "sess-1", observationId: "obs-2" },
      { sessionId: "sess-1", observationId: "obs-3" },
      { sessionId: "sess-2", observationId: "obs-6" },
    ],
  };
}
