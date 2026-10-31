import type { Terminal, IDisposable } from '@xterm/xterm'

export interface XtermMouseEvent {
  col: number; row: number; x: number; y: number
  button: number; action: number; ctrl?: boolean; alt?: boolean; shift?: boolean
}

/** The only adapter to internals of pinned xterm 6.0.0; tested against the installed package. */
export interface XtermCore {
  screenElement?: HTMLElement
  _mouseService?: { getMouseReportCoords(event: MouseEvent, element: HTMLElement): { col: number; row: number; x: number; y: number } | undefined }
  _renderService?: {
    dimensions: { css: { cell: { width: number; height: number } } }
    onRender: (listener: () => void) => IDisposable
  }
  coreMouseService: {
    activeProtocol: string
    activeEncoding: string
    onProtocolChange: (listener: () => void) => IDisposable
    triggerMouseEvent: (event: XtermMouseEvent) => boolean
  }
  coreService: {
    decPrivateModes: { applicationCursorKeys: boolean }
    triggerDataEvent: (data: string, userInput?: boolean) => void
  }
}

export function xtermCore(term: Terminal): XtermCore {
  return (term as unknown as { _core: XtermCore })._core
}

export function isTerminalMouseReport(data: string): boolean {
  return /^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/.test(data)
}
