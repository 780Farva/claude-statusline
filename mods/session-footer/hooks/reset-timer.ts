// One redraw at the moment the 5-hour window resets.
//
// Claude Code reruns its status line when a rate-limit window reaches its
// `resets_at` time and drops the window then. Nothing tells a mod about that
// moment, so the footer sets one timer for it. It is one timer at a known
// time, not polling.
//
// The timer is set again on every draw, replacing the last one: a draw's `$`
// calls can end when a newer draw replaces it, so the latest draw always owns
// the live timer. These are top-level functions because the hooks loader lets
// `$` be passed only to a function declared at the top of a file of the mod.

import type { EngineInterface } from 'claude-code'

/** The part of `$` the timer uses. */
export type ResetEngine = Pick<EngineInterface, 'clock' | 'ui'>

/** The pending reset redraw, if any; one per register call. */
export type ResetTimer = { pending: { cancel: () => void } | null }

/** How long after the reset time the redraw runs, so Claude Code has dropped the window. */
export const RESET_REDRAW_DELAY_MS = 1000

export function createResetTimer(): ResetTimer {
  return { pending: null }
}

/**
 * Replaces the pending redraw with one at `resetsAtMs`
 * (plus RESET_REDRAW_DELAY_MS). With no reset time, or one already past,
 * it only cancels.
 */
export function armResetRedraw(timer: ResetTimer, $: ResetEngine, resetsAtMs: number | null, nowMs: number): void {
  timer.pending?.cancel()
  timer.pending = null
  if (resetsAtMs === null || resetsAtMs <= nowMs) return
  timer.pending = $.clock.after(resetsAtMs - nowMs + RESET_REDRAW_DELAY_MS, () => {
    timer.pending = null
    $.ui.invalidate('ui.render')
  })
}
