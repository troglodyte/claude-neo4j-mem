// The rehearsal starts every test by wiping its target. A real memory graph can
// listen on the throwaway's port (setup-local.sh honours NEO4J_BOLT_PORT), so
// before wiping, the rehearsal counts entities outside its own fixture's
// projects: any at all means the target is not the throwaway.
export function assertRehearsalTarget(foreignEntityCount) {
  if (foreignEntityCount > 0) {
    throw new Error(
      `refusing to wipe the rehearsal target: it holds ${foreignEntityCount} entities outside the fixture's projects, ` +
        "so it is not a throwaway graph"
    );
  }
}
