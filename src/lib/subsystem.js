// Subsystem tags group observations *within* an entity, so a junk-drawer entity
// like "plugin:neo4j-memory" - 65 observations spanning auto-capture, search,
// backup and marketplace installs - can be sliced by topic instead of read
// whole. Tagging at the entity level was rejected for exactly that reason: the
// entities that most need slicing are the ones that span subsystems.
//
// Tags are free-form (the extraction model picks them), so they need the same
// anti-drift treatment entity names get, or the map they feed degrades into
// "capture", "captures" and "capture-hooks" as three separate rows.
import { resolveCanonicalName } from "./dedup.js";

// Deliberately not a valid slug: normalizeSubsystem strips the parentheses, so
// no real tag can ever collide with the bucket for untagged observations.
export const UNTAGGED = "(untagged)";

// A cross-cutting fact - a user preference, a project-wide constraint - has no
// subsystem, and the way to say so is to store null. Naming that state instead
// ("general", "misc") turns it into a tag, and a tag is something the extraction
// prompt then offers back as a preferred option: the backfill's schema made
// `subsystem` mandatory, so its prompt had to name the escape hatch, and 85% of
// what landed in "general" was not cross-cutting at all but merely unclassified.
// Rejecting these at the one write-side chokepoint means a model that reaches
// for a junk drawer gets the null it actually meant, whatever prompt it read.
const CATCH_ALL_TAGS = new Set([
  "general",
  "misc",
  "miscellaneous",
  "other",
  "others",
  "uncategorized",
  "uncategorised",
  "unclassified",
  "various",
  "untagged",
  "none",
  "n-a",
]);

/** True for a tag that names "no subsystem" rather than naming a subsystem. */
export function isCatchAllTag(value) {
  const slug = normalizeSubsystem(value);
  return slug !== null && CATCH_ALL_TAGS.has(slug);
}

/**
 * Drops catch-alls from a vocabulary before it is shown to an extraction model.
 * Without this the junk drawer is self-reinforcing: both capture and the
 * backfill seed their prompt from `listSubsystems` and say "prefer one of
 * these", so one bad batch teaches every later batch to do the same.
 */
export function filterVocabulary(subsystems = []) {
  return subsystems.filter((s) => !isCatchAllTag(s));
}

/** Lowercase kebab-case, or null for anything that isn't a usable tag. */
export function normalizeSubsystem(value) {
  if (typeof value !== "string") return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/**
 * Normalizes, then snaps onto an existing tag from the same project when it's a
 * close lexical match. Reuses the entity-name deduper rather than growing a
 * second similarity implementation to keep in step.
 *
 * A catch-all ("general", "misc") resolves to null - the same value an omitted
 * tag produces - so "no subsystem" has exactly one representation no matter
 * which prompt or caller produced it.
 *
 * This only catches lexical drift ("captures" -> "capture"). Semantic
 * convergence ("auto-capture" -> "capture") is the extraction prompt's job,
 * with `npm run usage` flagging it when both slip through.
 */
export function resolveSubsystem(value, knownSubsystems = []) {
  const slug = normalizeSubsystem(value);
  if (!slug || CATCH_ALL_TAGS.has(slug)) return null;
  return resolveCanonicalName(slug, filterVocabulary(knownSubsystems));
}
