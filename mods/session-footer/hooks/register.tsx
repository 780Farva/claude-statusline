import type { Register } from 'claude-code'
import {
  BLUE, CYAN, GRAY, GREEN, MUTED, ICON_BOLT, ICON_FOLDER,
  bar5, barColor, effortColor, fiveHourWindow, layoutFooter, normalizeModel, parseOptions, pickEffort,
  type Part,
} from './footer-format'
import { createEffortMemo, noteEffort, settingsRead } from './effort-memo'
import { createGitState, refreshGit } from './git-state'
import { armResetRedraw, createResetTimer } from './reset-timer'

// When the footer redraws. Every draw reads the model, usage, effort and git
// figures fresh, so the footer is right as long as it redraws whenever Claude
// Code's status changes. The triggers follow the ones Claude Code documents for
// its own status line ("When the status line updates",
// https://code.claude.com/docs/en/statusline):
//
//   Status line reruns when...          The footer redraws on...
//   a new assistant message arrives     classic.PostToolUse (each tool step) and
//                                       classic.Stop (turn end)
//   /compact finishes                   command.run, after any slash command ends
//                                       (also /clear, /model, /effort, /login)
//   permission or vim mode changes      the hint row's own props: the engine
//                                       redraws it by itself
//   a rate-limit window resets          one timer at the 5-hour resetsAt
//   (settings saved: effort, model)     the engine's own settings.read
//
// Git is read on the same events (forced after a tool call or turn end), and on
// each draw at most every 3 s, which catches changes made in another terminal.
// No timer polls anything.

// A settings or env read that fails (an aborted render, a denied read) counts
// as "not set", so the next source in the effort order still applies.
async function readOrUndefined<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read() } catch { return undefined }
}

export const register: Register = (on, options) => {
  const footerOptions = parseOptions(options)
  const gitState = createGitState({ now: Date.now })

  const hookEffort = createEffortMemo()
  const resetTimer = createResetTimer()

  // A new assistant message: redraw for the new usage figures, note the turn's
  // effort (main conversation only) and read git again.
  on('classic.PostToolUse', async ($, e, next) => {
    noteEffort(hookEffort, $, e)
    void refreshGit(gitState, $, true)
    $.ui.invalidate('ui.render')
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    noteEffort(hookEffort, $, e)
    void refreshGit(gitState, $, true)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // A slash command may change what the footer shows (/compact, /clear, /model,
  // /effort, /login): redraw once it has finished.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')
    return result
  })

  // An effort change saved to settings shows at once (see settingsRead).
  on('settings.read', async ($, e, next) => {
    const settings = await next(e)
    settingsRead(hookEffort, $, next.origin)
    return settings
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    void refreshGit(gitState, $)

    const modelRaw: string = await $.session.model()
    const u = await $.session.usage()
    const dir = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? '?'
    // The settings are read only when no hook event has carried a level. Each
    // read stands alone: one that fails leaves its source unset, and the rest
    // still count.
    const [envLevel, modelSettings, effortLevel, alwaysThinkingEnabled] = hookEffort.level
      ? [undefined, undefined, undefined, undefined]
      : await Promise.all([
          readOrUndefined(() => $.env.get('CLAUDE_CODE_EFFORT_LEVEL')),
          readOrUndefined(() => $.settings.read({ key: 'modelSettings' })),
          readOrUndefined(() => $.settings.read({ key: 'effortLevel' })),
          readOrUndefined(() => $.settings.read({ key: 'alwaysThinkingEnabled' })),
        ])
    const eff = pickEffort({ hookLevel: hookEffort.level, envLevel, modelSettings, model: modelRaw, effortLevel, alwaysThinkingEnabled })
    const model = modelRaw ? normalizeModel(modelRaw) : ''
    const ctx = Math.floor(u.context.percent ?? 0)
    // The 5-hour window, unless it has reset; redraw again at its reset.
    const now = await $.clock.now()
    const fiveHour = fiveHourWindow(u.rateLimits, now)
    armResetRedraw(resetTimer, $, fiveHour?.resetsAtMs ?? null, now)
    const five = fiveHour?.percent ?? null

    // right: [model ·] [effort | ] ctx | 5h
    const usage: Part[] = []
    if (eff) usage.push({ color: effortColor(eff), text: `${ICON_BOLT} ${eff}` })
    usage.push({ color: barColor(ctx, CYAN), text: `ctx ${bar5(ctx)} ${ctx}%` })
    if (five !== null) usage.push({ color: barColor(five, GREEN), text: `5h ${bar5(five)} ${five}%` })

    const columns = footerOptions.columns ?? e.viewport?.columns ?? 80
    const folderText = `${ICON_FOLDER} ${dir}`
    // left: folder [ | git ], the branch name shortened when the row is too narrow
    const { showModel, pad, gitPart: gp } = layoutFooter({
      folderText, git: gitState.current(), model, usage, columns, rightMargin: footerOptions.rightMargin,
    })

    const sep = <Text color={GRAY}> | </Text>
    const dot = <Text color={GRAY}> · </Text>
    const rightNodes: ReturnType<typeof Text>[] = []
    if (showModel) {
      rightNodes.push(<Text key="model" color={MUTED}>{model}</Text>)
      rightNodes.push(dot)
    }
    usage.forEach((p, i) => {
      if (i > 0) rightNodes.push(sep)
      rightNodes.push(<Text key={`u${i}`} color={p.color}>{p.text}</Text>)
    })
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={BLUE}>{folderText}</Text>
          {gp ? sep : null}
          {gp ? <Text color={gp.color}>{gp.text}</Text> : null}
          <Text>{' '.repeat(pad)}</Text>
          {rightNodes}
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
