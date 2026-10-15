import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

const REPORT = 'Memory stats: github.com/acme/widget\n  3 entities, 5 observations\n'
const SURFACES = ['terminal', 'desktop'] as const

// Run by `npm run test:mod` (`claude plugin test`), not node --test: the stats pane is the
// plugin's mod, hooks/stats-pane.tsx.
const PANE = {
  plugin: 'neo4j-memory',
  component: 'Pane',
  requestId: 'memory-stats',
  props: {
    title: 'Memory stats',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Script = { exitCode: number; stdout: string; stderr: string }

/** The pane as the surface holds it: open or not, and in front of other panes or behind one. */
type PaneState = { isOpen: boolean; isShown: boolean }

/**
 * Stands in for the machine beneath the mod: the stats script answers with `script` and
 * every argv it was run with lands in `runs`; opening and closing the pane move `pane`.
 */
function machine(on: On, runs: string[][], script: () => Script, pane: PaneState = { isOpen: false, isShown: true }) {
  on('clock.now', async () => ({ value: Date.UTC(2026, 9, 15, 12) }))
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    return { value: { ...script(), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', async () => {
    pane.isOpen = true
    pane.isShown = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => {
    pane.isOpen = false
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: pane.isOpen
      ? [{ id: 'memory-stats', title: 'Memory stats', isShown: pane.isShown, isFocused: false, isPlaced: true }]
      : [],
  }))
  return pane
}

/** `/memory-stats <args>` as the person typing it in the composer runs it. */
function slash(args: string): CommandRunInput {
  return {
    command: 'memory-stats',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  }
}

// The flags each run passed to the script: everything after the script's own path.
const flags = (runs: string[][]) => runs.map(argv => argv.slice(argv.findIndex(a => a.endsWith('memory-stats.mjs')) + 1))

test('/memory-stats runs the script for this project and the pane shows its report', async ($, on) => {
  const runs: string[][] = []
  machine(on, runs, () => ({ exitCode: 0, stdout: REPORT, stderr: '' }))

  const answer = await $.command.run(slash(''))

  expect(answer.text).toBe('Opened the memory stats pane.')
  expect(flags(runs)).toEqual([[]])
  // Through the launcher and the script of one plugin copy, the one that is loaded.
  const [shell = '', launcher = '', script = ''] = runs[0] ?? []
  const root = launcher.replace(/\/bin\/memory-node$/, '')
  expect(shell).toBe('bash')
  expect(root).not.toBe(launcher)
  expect(script).toBe(`${root}/scripts/memory-stats.mjs`)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(REPORT)
    await ui.unmount()
  }
})

test('/memory-stats passes --all and --project through to the script', async ($, on) => {
  const runs: string[][] = []
  machine(on, runs, () => ({ exitCode: 0, stdout: REPORT, stderr: '' }))

  await $.command.run(slash('--all'))
  await $.command.run(slash('  --project  github.com/acme/gadget '))

  expect(flags(runs)).toEqual([['--all'], ['--project', 'github.com/acme/gadget']])
})

test('the scope button switches between all projects and this one, and Refresh keeps the scope', async ($, on) => {
  const runs: string[][] = []
  machine(on, runs, () => ({ exitCode: 0, stdout: REPORT, stderr: '' }))
  await $.command.run(slash(''))

  for (const surface of SURFACES) {
    runs.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'scope' })
    expect((await ui.find({ key: 'scope' }))?.props.label).toBe('This project')
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'scope' })
    expect(flags(runs)).toEqual([['--all'], ['--all'], []])
    await ui.unmount()
  }
})

test('a failed run shows why and keeps the last good report', async ($, on) => {
  const runs: string[][] = []
  let isBroken = false
  machine(on, runs, () =>
    isBroken ? { exitCode: 1, stdout: '', stderr: 'memory-stats: no memory store at /x\n' } : { exitCode: 0, stdout: REPORT, stderr: '' },
  )
  await $.command.run(slash(''))
  isBroken = true

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ type: 'Text', text: /no memory store/ }))?.props.color).toBe('red')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(REPORT)
    await ui.unmount()
  }
})

test('a turn ending refreshes an open pane', async ($, on) => {
  const runs: string[][] = []
  machine(on, runs, () => ({ exitCode: 0, stdout: REPORT, stderr: '' }))
  on('turn.complete', async () => ({ text: '' }))
  await $.command.run(slash('--all'))

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(flags(runs)).toEqual([['--all'], ['--all']])
})

test('a bare /memory-stats closes the pane that is showing, and opens it again after', async ($, on) => {
  const runs: string[][] = []
  const pane = machine(on, runs, () => ({ exitCode: 0, stdout: REPORT, stderr: '' }))
  await $.command.run(slash(''))

  const closed = await $.command.run(slash(''))

  expect(pane.isOpen).toBe(false)
  expect(closed.text).toBe('Closed the memory stats pane.')
  await $.command.run(slash(''))
  expect(pane.isOpen).toBe(true)
})

test('a bare /memory-stats brings forward a pane hidden behind another instead of closing it', async ($, on) => {
  const runs: string[][] = []
  const pane = machine(on, runs, () => ({ exitCode: 0, stdout: REPORT, stderr: '' }), { isOpen: true, isShown: false })

  await $.command.run(slash(''))

  expect(pane).toEqual({ isOpen: true, isShown: true })
})

test('/memory-stats with flags on an open pane switches its scope instead of closing it', async ($, on) => {
  const runs: string[][] = []
  const pane = machine(on, runs, () => ({ exitCode: 0, stdout: REPORT, stderr: '' }))
  await $.command.run(slash(''))

  await $.command.run(slash('--all'))

  expect(pane.isOpen).toBe(true)
  expect(flags(runs)).toEqual([[], ['--all']])
})
