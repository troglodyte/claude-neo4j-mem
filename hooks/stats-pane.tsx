// The plugin's mod: /memory-stats shows or hides a pane with `npm run stats`'s report for the
// project the session is in. The hooks module runs with no Node and no node:sqlite, so the
// report comes from the plugin's own script, started through bin/memory-node like every other
// memory process. Tests: tests/stats-pane.test.ts, under `npm run test:mod`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StatsView } from '../types'

const PANE = 'memory-stats'
const TITLE = 'Memory stats'
const SCRIPT = 'scripts/memory-stats.mjs'
const RUN_TIMEOUT_MS = 15_000

const view = atom({ plugin: 'neo4j-memory', key: 'statsView' } as const, {
  args: [],
  text: '',
  error: null,
  updatedAt: null,
  isLoading: false,
})

/**
 * Runs the stats script in the session's working directory, which is how it reports the project
 * being worked on. A failed run keeps the last good report and shows why beside it; it never
 * rejects, so a caller that does not wait on it leaves nothing unhandled.
 */
async function refresh($: EngineInterface, args: string[]) {
  try {
    await update($, view, current => ({ ...current, args, isLoading: true }))
    const run = await $.process.run(
      ['bash', `${$.plugin.root}/bin/memory-node`, `${$.plugin.root}/${SCRIPT}`, ...args],
      { timeoutMs: RUN_TIMEOUT_MS },
    )
    const isOk = run.exitCode === 0
    const updatedAt = await $.clock.now()
    await update($, view, current => ({
      ...current,
      text: isOk ? run.stdout : current.text,
      error: isOk ? null : (run.stderr || run.stdout).trim() || `exited ${run.exitCode}`,
      updatedAt,
      isLoading: false,
    }))
  } catch (error) {
    const updatedAt = await $.clock.now()
    await update($, view, current => ({ ...current, error: String(error), updatedAt, isLoading: false }))
  }
}

// Press handlers read the scope from state rather than the drawing, so a press after a change
// that has not been redrawn yet still runs the scope on screen.
async function rerun($: EngineInterface) {
  const { args } = await read($, view)
  await refresh($, args)
}

async function toggleScope($: EngineInterface) {
  const { args } = await read($, view)
  await refresh($, args[0] === '--all' ? [] : ['--all'])
}

function stamp(view: StatsView): string {
  if (view.isLoading) {
    return 'refreshing…'
  }
  return view.updatedAt === null ? '' : `updated ${new Date(view.updatedAt).toLocaleTimeString()}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'memory-stats',
      description: 'Show or hide a pane with memory stats for this project',
      argumentHint: '[--all | --project ID]',
    })
    return next(e)
  })

  // A bare /memory-stats toggles: it closes the pane when that is what the person is looking at,
  // and otherwise opens it or brings it in front. With flags it always opens, on that scope.
  on('command.run', { command: 'memory-stats' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const panes = await $.ui.panes()
    if (args.length === 0 && panes.some(pane => pane.id === PANE && pane.isShown)) {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the memory stats pane.' }
    }
    await refresh($, args)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (opened.isPlaced) {
      return { text: 'Opened the memory stats pane.' }
    }
    // Nowhere to draw a pane (no surface attached): print the report instead.
    const { text, error } = await read($, view)
    return { text: error ?? text }
  })

  // Memory tools write during a turn, so a report on screen is stale once one ends. The run is
  // awaited so it finishes inside this dispatch; its time is the script's, not the hook's budget.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      await rerun($)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const current = await read($, view)
    const isAll = current.args[0] === '--all'
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void rerun($)} />
          <Button
            key="scope"
            label={isAll ? 'This project' : 'All projects'}
            hotkey="a"
            onPress={() => void toggleScope($)}
          />
          <Text dimColor>{stamp(current)}</Text>
        </Box>
        {current.error !== null && <Text color="red">{current.error}</Text>}
        {current.text === '' ? (
          <Text dimColor>{current.isLoading ? 'Loading…' : 'No report yet.'}</Text>
        ) : (
          <Code source={current.text} language="text" />
        )}
      </Box>
    )
  })
}
