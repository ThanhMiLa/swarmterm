import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import path from 'node:path'
import { Terminal } from '@xterm/xterm'
// Deliberately load the actual ESM entrypoint as well as the package's CJS entrypoint.
// @ts-expect-error the subpath has no standalone declarations
import { Terminal as EsmTerminal } from '@xterm/xterm/lib/xterm.mjs'

interface WriteBufferProbe {
  _action: () => void
  write: (data: string, callback: () => void) => void
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

for (const [entrypoint, Constructor] of [['CJS', Terminal], ['ESM', EsmTerminal]] as const) {
  describe(`installed xterm patch (${entrypoint})`, () => {
    it('yields between chunks after 4ms rather than consuming a 12ms slice', () => {
      vi.useFakeTimers()
      const terminal = new Constructor({ allowProposedApi: true }) as Terminal
      const buffer = (terminal as unknown as { _core: { _writeBuffer: WriteBufferProbe } })._core._writeBuffer
      let clock = 100
      let parsed = 0
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      buffer._action = () => { clock += 5 }
      buffer.write('a', () => parsed++)
      buffer.write('b', () => parsed++)
      vi.runOnlyPendingTimers()
      expect(parsed).toBe(1)
      vi.runOnlyPendingTimers()
      expect(parsed).toBe(2)
      terminal.dispose()
    })

    it('exposes enhancedWheel consistently with compatibility as the library default', () => {
      const terminal = new Constructor() as Terminal
      expect(terminal.options.enhancedWheel).toBe(false)
      terminal.options.enhancedWheel = true
      expect(terminal.options.enhancedWheel).toBe(true)
      terminal.dispose()
    })
  })
}

describe('pinned viewport source regression', () => {
  let Viewport: any
  let Scrollable: any
  beforeAll(async () => {
    // Compile the shipped patched source, with its real scroll animator. DOM
    // geometry alone is stubbed; the code that cancelled gestures is not mocked.
    const root = path.resolve('node_modules/@xterm/xterm/src')
    const output = await build({
      stdin: { contents: "export { Viewport } from './browser/Viewport'; export { Scrollable } from './vs/base/common/scrollable'", resolveDir: root, loader: 'ts' },
      bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2020',
      alias: Object.fromEntries(['browser', 'common', 'vs'].map(p => [p, path.join(root, p)])),
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }
    })
    const module = { exports: {} as any }
    new Function('module', 'exports', output.outputFiles[0].text)(module, module.exports)
    ;({ Viewport, Scrollable } = module.exports)
  })

  for (const enhancedWheel of [false, true]) {
    it(`${enhancedWheel ? 'preserves' : 'compatibility cancels'} a gesture when output trims scrollback before its first frame`, () => {
      vi.useFakeTimers()
      let frame: (() => void) | undefined
      const cancel = vi.fn(() => { frame = undefined })
      const scrollable = new Scrollable({ forceIntegerValues: false, smoothScrollDuration: 100,
        scheduleAtNextAnimationFrame: (callback: () => void) => { frame = callback; return { dispose: cancel } } })
      scrollable.setScrollDimensions({ height: 400, scrollHeight: 80000 }, false)
      scrollable.setScrollPositionNow({ scrollTop: 40000 })
      scrollable.setScrollPositionSmooth({ scrollTop: 39800 })
      const originalFrame = frame
      const viewport = Object.assign(Object.create(Viewport.prototype), {
        _scrollable: scrollable,
        _scrollableElement: {
          setScrollDimensions: (dimensions: unknown) => scrollable.setScrollDimensions(dimensions, false),
          setScrollPosition: (position: unknown) => scrollable.setScrollPositionNow(position)
        },
        _bufferService: { buffer: { ydisp: 2499, lines: { length: 5000 } } },
        _renderService: { dimensions: { css: { canvas: { height: 400 }, cell: { height: 16 } } } },
        _optionsService: { rawOptions: { enhancedWheel } },
        _latestYDisp: 2500, _isSyncing: false
      })
      viewport._sync()
      expect(scrollable.hasPendingScrollAnimation()).toBe(enhancedWheel)
      expect(scrollable.getCurrentScrollPosition().scrollTop).toBe(39984)
      if (enhancedWheel) {
        expect(frame).toBe(originalFrame)
        expect(cancel).not.toHaveBeenCalled()
        expect(scrollable.getFutureScrollPosition().scrollTop).toBe(39784)
        vi.advanceTimersByTime(110)
        frame!()
        expect(scrollable.hasPendingScrollAnimation()).toBe(false)
        expect(scrollable.getCurrentScrollPosition().scrollTop).toBe(39784)
      }
      scrollable.dispose()
    })
  }
})
