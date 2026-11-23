import { expect, test } from 'claude-code/testing'
import { RESET_REDRAW_DELAY_MS, armResetRedraw, createResetTimer, type ResetEngine } from '../hooks/reset-timer'

// A fake `$` whose clock records each timer and whose ui counts redraws.
function fakeEngine() {
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const redraws: string[] = []
  const $ = {
    clock: {
      after: (ms: number, fn: () => void) => {
        const t = { ms, fn, cancelled: false }
        timers.push(t)
        return { cancel: () => { t.cancelled = true } }
      },
    },
    ui: { invalidate: (name: string) => { redraws.push(name) } },
  } as unknown as ResetEngine
  return { $, timers, redraws }
}

const NOW = 1_000_000

test('arms one redraw just after the reset time', async () => {
  const timer = createResetTimer()
  const { $, timers } = fakeEngine()

  armResetRedraw(timer, $, NOW + 60_000, NOW)

  expect(timers.map((t) => t.ms)).toEqual([60_000 + RESET_REDRAW_DELAY_MS])
})

test('arming again replaces the pending redraw', async () => {
  const timer = createResetTimer()
  const { $, timers } = fakeEngine()

  armResetRedraw(timer, $, NOW + 60_000, NOW)
  armResetRedraw(timer, $, NOW + 60_000, NOW + 10_000)

  expect(timers.map((t) => t.cancelled)).toEqual([true, false])
  expect(timers[1]?.ms).toBe(50_000 + RESET_REDRAW_DELAY_MS)
})

test('no reset time, or one already past, only cancels', async () => {
  const timer = createResetTimer()
  const { $, timers } = fakeEngine()
  armResetRedraw(timer, $, NOW + 60_000, NOW)

  armResetRedraw(timer, $, null, NOW)
  armResetRedraw(timer, $, NOW - 1, NOW)

  expect(timers).toHaveLength(1)
  expect(timers[0]?.cancelled).toBe(true)
  expect(timer.pending).toBeNull()
})

test('the redraw invalidates the footer and clears the pending timer', async () => {
  const timer = createResetTimer()
  const { $, timers, redraws } = fakeEngine()
  armResetRedraw(timer, $, NOW + 60_000, NOW)

  timers[0]?.fn()

  expect(redraws).toEqual(['ui.render'])
  expect(timer.pending).toBeNull()
})
