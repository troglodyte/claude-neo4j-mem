// The plugin's mod contract: the session state the stats pane (hooks/stats-pane.tsx) keeps.

/** What the stats pane draws: the last run of the stats script and the scope it ran for. */
export type StatsView = {
  /** Passed through to memory-stats.mjs: [] for this project, ['--all'], or ['--project', id]. */
  args: string[]
  /** The report as the script printed it. */
  text: string
  /** Why the last run failed, from its stderr; null when it succeeded. */
  error: string | null
  /** When the last run finished, in epoch milliseconds; null before the first. */
  updatedAt: number | null
  isLoading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'neo4j-memory': { statsView: StatsView }
  }
}
