import { afterEach, describe, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: any): Promise<any> => ({ ok: true })) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: calls.invoke, Channel: class { onmessage?: unknown } }))
import { createTerminal, writeTerminal, writeTerminalBytes, killTerminal } from './terminal'

afterEach(() => calls.invoke.mockReset().mockResolvedValue({ ok: true }))

describe('terminal transport generation', () => {
  it('binds all text and binary input to the creation token and replaces it on respawn', async () => {
    await createTerminal('token-test', { cols: 80, rows: 24 }, () => {})
    const first = calls.invoke.mock.calls[0][1].options.inputToken
    expect(typeof first).toBe('string')
    await writeTerminal('token-test', 'hello')
    expect(calls.invoke).toHaveBeenLastCalledWith('write_terminal', { id: 'token-test', data: 'hello', inputToken: first })
    await writeTerminalBytes('token-test', [27, 91, 77, 183])
    expect(calls.invoke).toHaveBeenLastCalledWith('write_terminal_bytes', { id: 'token-test', bytes: [27, 91, 77, 183], inputToken: first })
    await killTerminal('token-test')
    await createTerminal('token-test', { cols: 80, rows: 24 }, () => {})
    const second = calls.invoke.mock.calls.at(-1)![1].options.inputToken
    expect(second).not.toBe(first)
    await writeTerminal('token-test', 'fresh')
    expect(calls.invoke).toHaveBeenLastCalledWith('write_terminal', { id: 'token-test', data: 'fresh', inputToken: second })
    await killTerminal('token-test')
  })
})
