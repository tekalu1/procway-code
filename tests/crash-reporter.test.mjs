import { describe, it, expect, vi, afterEach } from 'vitest'
import { CRASH_MARKER, emitCrash } from '../src/telemetry/crash-reporter.mjs'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('crash-reporter / emitCrash', () => {
  it('writes a single structured crash line marked for the dashboard relay', () => {
    const lines = []
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      lines.push(String(s))
      return true
    })

    emitCrash('uncaughtException', new Error('boom'))

    expect(lines).toHaveLength(1)
    expect(lines[0].endsWith('\n')).toBe(true)
    const payload = JSON.parse(lines[0])
    expect(payload[CRASH_MARKER]).toBe(true)
    expect(payload).toMatchObject({ level: 'fatal', app: 'ai-agent', kind: 'uncaughtException', message: 'boom' })
    expect(typeof payload.stack).toBe('string')
    expect(typeof payload.ts).toBe('string')
  })

  it('omits the stack but keeps the marker when includeStack is false (TUI mode)', () => {
    const lines = []
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      lines.push(String(s))
      return true
    })

    emitCrash('unhandledRejection', new Error('boom'), { includeStack: false })

    expect(lines).toHaveLength(1)
    const payload = JSON.parse(lines[0])
    expect(payload[CRASH_MARKER]).toBe(true)
    expect(payload.message).toBe('boom')
    expect(payload.stack).toBeNull()
    expect(lines[0]).not.toContain('at ')
  })

  it('handles non-Error reasons without throwing', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(() => emitCrash('unhandledRejection', 'plain string reason')).not.toThrow()
  })
})
