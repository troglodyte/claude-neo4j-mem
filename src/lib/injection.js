// The SessionStart injection, as a pure function so it can be tested without a
// database and measured by scripts/token-cost.mjs without a second copy of the
// formatting drifting out of step with this one.
//
// It replaced a dump of the 15 most recently touched entities with three
// observations each (~6.4k chars, ~2.3k tokens, paid every session). That
// version was ordered by recency rather than by usefulness - standing
// preferences competed for slots with one-off decisions and usually lost - and
// carried no index, so nothing told the model what else was in memory.
//
// What replaces it has two parts, neither of which grows with the graph: the
// facts that always apply, verbatim, and a table of contents for the rest.
import { UNTAGGED } from "./subsystem.js";

// MCP already registers every memory_* tool with its own description, so
// restating their names here is duplication paid once per session for nothing.
// What's left is the behaviour MCP doesn't carry: when to write, and the one
// tool that is destructive if called unprompted.
const TOOLS_BLURB =
  "Log durable facts with memory_add_observations (auto-capture also runs at compaction and " +
  "session end, so you don't need to log everything manually). Never call memory_prune with " +
  "dryRun: false unless the user explicitly asks to clean up old memories.";

// Month-day only: the year is almost always the current one, and this string is
// repeated once per tag.
const shortDate = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(5, 10) : "?");

export function renderInjection({ project, pinned, map = [] }) {
  const sections = [`## Memory (Neo4j · ${project})`];

  const facts = pinned?.facts ?? [];
  if (facts.length > 0) {
    let block = `Always applies:\n${facts.map((fact) => `- ${fact.text}`).join("\n")}`;
    // A standing preference the model never sees may as well not exist, so if
    // the budget bit, say so rather than letting a partial list read as whole.
    if (pinned.truncated) {
      block +=
        `\n- [${pinned.total - pinned.returned} more standing fact(s) not shown — ` +
        `memory_search("preference") or memory_search("constraint") to read them]`;
    }
    sections.push(block);
  }

  if (map.length > 0) {
    const hasTags = map.some((row) => row.subsystem !== UNTAGGED);
    const how = hasTags ? "memory_search(subsystem: …) to read" : "memory_search to read";
    const cells = map.map((row) => `${row.subsystem} (${row.observations}, ${shortDate(row.lastSeen)})`);
    sections.push(`Tagged history — ${how}:\n  ${cells.join(" · ")}`);
  }

  sections.push(TOOLS_BLURB);
  return sections.join("\n\n");
}
