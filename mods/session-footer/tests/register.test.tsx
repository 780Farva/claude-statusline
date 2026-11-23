import { expect, mock, test } from 'claude-code/testing'

// The footer as Claude Code asks for it: the PromptHint row under the prompt.
const FOOTER = {
  plugin: 'session-footer',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const porcelain = (branch: string) =>
  `# branch.oid 00aa75f0c2068fb2b22773d905f8df8458fb85a5\n# branch.head ${branch}\n`

// The time the fake engine's clock starts at.
const START = Date.parse('2026-11-23T12:00:00Z')

type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
type Engine = {
  branch: string; fail: boolean; gitRuns: number; statusLines: string[]; stash: string
  ctx: number; rateLimits: RateLimit[]; clock: ReturnType<typeof mock.clock>
}

// Each hook here stands for the engine: it answers the mod's `$` calls.
// `engine.branch` is what `git status` reports, `engine.statusLines` any more
// porcelain lines and `engine.stash` what `git stash list` prints;
// `engine.fail` makes the run throw, as an aborted `$.process.run` does.
// `engine.ctx` and `engine.rateLimits` are what `$.session.usage()` reports; a
// window past its resetsAt is dropped, as Claude Code drops it. `engine.clock`
// is the kit's mock clock, starting at START.
// `world.settingsFail` makes every settings read throw; `world.env` answers env.get.
// `world.keepExpired` keeps reporting a window past its reset, as an engine slow
// to drop it would.
type World = { settings?: Record<string, unknown>; settingsFail?: boolean; env?: Record<string, string>; keepExpired?: boolean }
function fakeEngine(on: any, world: World = {}): Engine {
  const { settings = {}, settingsFail = false, env = {}, keepExpired = false } = world
  const clock = mock.clock(on, { now: START })
  const engine: Engine = {
    branch: 'main', fail: false, gitRuns: 0, statusLines: [], stash: '',
    ctx: 9, rateLimits: [{ kind: 'five_hour', percentUsed: 13 }], clock,
  }
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/work/claude-statusline' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { percent: engine.ctx },
      rateLimits: engine.rateLimits.filter((r) => keepExpired || !r.resetsAt || Date.parse(r.resetsAt) > clock.now()),
    },
  }))
  on('settings.read', () => {
    if (settingsFail) throw new Error('settings unreadable')
    return { value: settings }
  })
  on('env.get', (_: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('classic.Stop', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv.includes('stash')) return { value: { exitCode: 0, stdout: engine.stash, stderr: '' } }
    engine.gitRuns++
    if (engine.fail) throw new Error('aborted')
    const stdout = porcelain(engine.branch) + engine.statusLines.map((l) => l + '\n').join('')
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return engine
}

// Raises the end of a turn, which refreshes git past the 3 s throttle.
const endTurn = ($: any) => $.classic.Stop({ stop_hook_active: false })
const afterToolCall = ($: any) =>
  $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'git checkout -b x' }, tool_response: {} })

const branchText = async (ui: any) => (await ui.find({ type: 'Text', text: /\u{f126}/u }))?.text

test('effort follows modelSettings for the current model over effortLevel', async ($, on) => {
  fakeEngine(on, { settings: { effortLevel: 'xhigh', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } } })
  const ui = await $.ui.mount(FOOTER)

  expect((await ui.find({ type: 'Text', text: /\u{f0e7}/u }))?.text).toBe('\u{f0e7} high')
  await ui.unmount()
})

const effortText = async (ui: any) => (await ui.find({ type: 'Text', text: /\u{f0e7}/u }))?.text

// The forgetting on a settings change is covered in effort-memo.test.ts: the
// test kit's engine `$` has no settings noun to raise the engine's own read.
test('the effort a turn ran at shows over the saved setting', async ($, on) => {
  fakeEngine(on, { settings: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } } })
  const ui = await $.ui.mount(FOOTER)
  expect(await effortText(ui)).toBe('\u{f0e7} high')

  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'max' } })

  expect(await effortText(ui)).toBe('\u{f0e7} max')
  await ui.unmount()
})

test('a failed settings read still shows the effort from CLAUDE_CODE_EFFORT_LEVEL', async ($, on) => {
  fakeEngine(on, { settingsFail: true, env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } })
  const ui = await $.ui.mount(FOOTER)

  expect((await ui.find({ type: 'Text', text: /\u{f0e7}/u }))?.text).toBe('\u{f0e7} medium')
  await ui.unmount()
})

// The icons are Nerd Font private-use characters: they draw as blanks outside a
// Nerd Font, so a lost one is easy to miss by eye. Pin the exact code points.
test('the footer draws its Nerd Font icons', { options: { columns: '160' } }, async ($, on) => {
  const engine = fakeEngine(on, { settings: { effortLevel: 'xhigh' } })
  engine.branch = 'pr-1'
  engine.statusLines = ['# branch.ab +1 -0', '1 .M N... 1 1 1 a b f.ts', '1 M. N... 1 1 1 a b g.ts']
  engine.stash = 'stash@{0}: WIP\n'
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)

  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(texts).toContain('\u{f07c} claude-statusline')
  expect(texts).toContain('\u{f126} pr-1 \u{21e1}1 \u{f044} 1 \u{f046} 1 \u{eb4b} 1')
  expect(texts).toContain('\u{f0e7} xhigh')
  await ui.unmount()
})

test('a clean branch is drawn with the branch icon and a check mark', { options: { columns: '160' } }, async ($, on) => {
  fakeEngine(on)
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)

  expect(await branchText(ui)).toBe('\u{f126} main \u{2714}')
  await ui.unmount()
})

test('a branch name with a slash is shown in full', { options: { columns: '120' } }, async ($, on) => {
  const engine = fakeEngine(on)
  engine.branch = 'feature/footer-fix'
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)

  expect(await branchText(ui)).toContain('feature/footer-fix')
  await ui.unmount()
})

test('a branch name too long for the row is shortened in the middle', { options: { columns: '100' } }, async ($, on) => {
  const engine = fakeEngine(on)
  engine.branch = 'feature/ABC-1234-session-footer-git-state-refresh'
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)

  const text = await branchText(ui)
  expect(text?.startsWith('\u{f126} feature/ABC-1234-')).toBe(true)
  expect(text).toContain('…')
  expect(text?.endsWith('state-refresh \u{2714}')).toBe(true)
  await ui.unmount()
})

test('a tool call refreshes git straight away, inside the 3 s throttle', async ($, on) => {
  const engine = fakeEngine(on)
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)
  expect(await branchText(ui)).toContain('main')

  engine.branch = 'release/1.0'
  await afterToolCall($)

  expect(await branchText(ui)).toContain('release/1.0')
  await ui.unmount()
})

test('an aborted git run keeps the last branch instead of blanking it', async ($, on) => {
  const engine = fakeEngine(on)
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)
  expect(await branchText(ui)).toContain('main')

  engine.fail = true
  const before = engine.gitRuns
  await afterToolCall($)

  expect(engine.gitRuns).toBeGreaterThan(before)
  expect(await branchText(ui)).toContain('main')
  await ui.unmount()
})

// --- when the footer redraws: the same triggers as Claude Code's status line ---

const ctxText = async (ui: any) => (await ui.find({ type: 'Text', text: /^ctx / }))?.text
const fiveText = async (ui: any) => (await ui.find({ type: 'Text', text: /^5h / }))?.text

test('a tool call redraws the context and 5h figures', async ($, on) => {
  const engine = fakeEngine(on)
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)
  expect(await ctxText(ui)).toBe('ctx ◻◻◻◻◻ 9%')

  engine.ctx = 55
  engine.rateLimits = [{ kind: 'five_hour', percentUsed: 40 }]
  await afterToolCall($)

  expect(await ctxText(ui)).toBe('ctx ◼◼◻◻◻ 55%')
  expect(await fiveText(ui)).toBe('5h ◼◼◻◻◻ 40%')
  await ui.unmount()
})

test('a turn end redraws the context figure', async ($, on) => {
  const engine = fakeEngine(on)
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)
  // A read settles any redraw already queued, so only the next event can redraw.
  expect(await ctxText(ui)).toBe('ctx ◻◻◻◻◻ 9%')

  engine.ctx = 81
  await endTurn($)

  expect(await ctxText(ui)).toBe('ctx ◼◼◼◼◻ 81%')
  await ui.unmount()
})

test('a slash command redraws the footer once it ends', async ($, on) => {
  const engine = fakeEngine(on)
  on('command.run', () => ({ text: 'Compacted' }))
  const ui = await $.ui.mount(FOOTER)
  await endTurn($)
  // A read settles any redraw already queued, so only the command can redraw.
  expect(await ctxText(ui)).toBe('ctx ◻◻◻◻◻ 9%')

  engine.ctx = 3
  await ($ as any).command.run({ command: 'compact', args: '', origin: { kind: 'composer' }, presentation: { columns: 80 } })

  expect(await ctxText(ui)).toBe('ctx ◻◻◻◻◻ 3%')
  await ui.unmount()
})

test("a subagent's tool call does not change the effort shown", async ($, on) => {
  fakeEngine(on, { settings: { effortLevel: 'xhigh' } })
  const ui = await $.ui.mount(FOOTER)
  expect(await effortText(ui)).toBe('\u{f0e7} xhigh')

  await $.classic.PostToolUse({
    tool_name: 'Grep', tool_input: {}, tool_response: {}, agent_id: 'docs-agent', effort: { level: 'medium' },
  } as any)

  expect(await effortText(ui)).toBe('\u{f0e7} xhigh')
  await ui.unmount()
})

test('the 5h figure goes at its reset time with no other event', async ($, on) => {
  const engine = fakeEngine(on)
  engine.rateLimits = [{ kind: 'five_hour', percentUsed: 13, resetsAt: new Date(START + 60_000).toISOString() }]
  const ui = await $.ui.mount(FOOTER)
  expect(await fiveText(ui)).toBe('5h ◻◻◻◻◻ 13%')

  await engine.clock.advance(59_000)
  expect(await fiveText(ui)).toBe('5h ◻◻◻◻◻ 13%')

  await engine.clock.advance(3_000)
  expect(await fiveText(ui)).toBeUndefined()
  await ui.unmount()
})

test('a 5h reading past its reset is not drawn, even if still reported', async ($, on) => {
  const engine = fakeEngine(on, { keepExpired: true })
  engine.rateLimits = [{ kind: 'five_hour', percentUsed: 97, resetsAt: new Date(START - 1_000).toISOString() }]
  const ui = await $.ui.mount(FOOTER)

  expect(await fiveText(ui)).toBeUndefined()
  expect(await ctxText(ui)).toBe('ctx ◻◻◻◻◻ 9%')
  await ui.unmount()
})
