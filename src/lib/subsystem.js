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
 * This only catches lexical drift ("captures" -> "capture"). Semantic
 * convergence ("auto-capture" -> "capture") is the extraction prompt's job,
 * with `npm run usage` flagging it when both slip through.
 */
export function resolveSubsystem(value, knownSubsystems = []) {
  const slug = normalizeSubsystem(value);
  if (!slug) return null;
  return resolveCanonicalName(slug, knownSubsystems);
}
