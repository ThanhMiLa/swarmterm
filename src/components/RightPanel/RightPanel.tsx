// src/components/RightPanel/RightPanel.tsx
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react'
import { Eye, GitBranch, RotateCw, Swords, X } from 'lucide-react'
import { useGitStore } from '@/store/git-store'
import { BrowserColumn } from '@/components/Browser/BrowserColumn'
import { GitPanel } from '@/components/Git/GitPanel'
import { WarRoomPanel } from '@/components/WarRoom/WarRoomPanel'
import { beginLayoutTransition, endLayoutTransition } from '@/lib/terminal-registry'
import { cn } from '@/lib/utils'

const WIDTH_STORAGE_KEY = 'cc-right-panel-width'

function clampPanelWidth(width: number): number {
  return Math.min(Math.max(260, window.innerWidth * 0.55), Math.max(260, width))
}

function initialPanelWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY))
    return clampPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : 400)
  } catch {
    return clampPanelWidth(400)
  }
}

function RefreshButton(): ReactElement {
  const refresh = useGitStore((s) => s.refresh)
  return (
    <button
      onClick={refresh}
      className="ml-auto flex items-center px-2 text-muted-foreground hover:text-foreground"
      aria-label="Refresh"
      title="Refresh git"
    >
      <RotateCw className="h-3.5 w-3.5" />
    </button>
  )
}

export function RightPanel(): ReactElement {
  const panelOpen = useGitStore((s) => s.panelOpen)
  const mode = useGitStore((s) => s.mode)
  const setMode = useGitStore((s) => s.setMode)
  const setPanelOpen = useGitStore((s) => s.setPanelOpen)
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth)
  const [isResizing, setIsResizing] = useState(false)
  const previousOpen = useRef(panelOpen)
  const layoutTransition = useRef(0)
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const widthRef = useRef(panelWidth)

  useLayoutEffect(() => {
    if (previousOpen.current === panelOpen) return
    previousOpen.current = panelOpen
    layoutTransition.current = beginLayoutTransition(220)
  }, [panelOpen])

  useEffect(() => {
    const clamp = (): void => {
      const width = clampPanelWidth(widthRef.current)
      widthRef.current = width
      setPanelWidth(width)
    }
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  function startResize(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeStart.current = { pointerId: e.pointerId, x: e.clientX, width: panelWidth }
    setIsResizing(true)
    // A drag can interrupt an opening animation: return to live, frame-batched fits.
    endLayoutTransition(layoutTransition.current)
  }

  function moveResize(e: PointerEvent<HTMLDivElement>): void {
    const start = resizeStart.current
    if (!start || start.pointerId !== e.pointerId) return
    const width = clampPanelWidth(start.width + start.x - e.clientX)
    widthRef.current = width
    setPanelWidth(width)
  }

  function finishResize(e: PointerEvent<HTMLDivElement>): void {
    if (resizeStart.current?.pointerId !== e.pointerId) return
    resizeStart.current = null
    setIsResizing(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(widthRef.current))
    } catch {
      // Resizing still works when storage is unavailable.
    }
  }

  function handleClose(): void {
    setPanelOpen(false)
  }

  function handleBrowserTab(): void {
    setMode('browser')
  }

  function handleGitTab(): void {
    setMode('git')
  }

  function handleWarRoomTab(): void {
    setMode('warroom')
  }

  return (
    <aside
      aria-hidden={!panelOpen}
      inert={!panelOpen}
      style={{ width: panelOpen ? panelWidth : 0 }}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'width') endLayoutTransition(layoutTransition.current)
      }}
      className={cn(
        'relative h-full shrink-0 overflow-hidden border-l bg-background',
        panelOpen ? 'border-border' : 'border-transparent',
        !isResizing && 'transition-[width,border-color] duration-200 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
      )}
    >
      {panelOpen && (
        <div
          data-focus-return
          role="separator"
          aria-label="Resize right panel"
          aria-orientation="vertical"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none select-none hover:bg-ring"
        />
      )}
      <div
        style={{ width: panelWidth }}
        className={cn(
          'flex h-full flex-col pl-1 transition-[transform,opacity] duration-200 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] will-change-[transform,opacity] motion-reduce:transition-none',
          panelOpen ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'
        )}
      >
        {/* Mode tab strip */}
        <div className="flex shrink-0 items-stretch border-b border-border bg-muted/30">
          <button
            onClick={handleBrowserTab}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
              mode === 'browser'
                ? 'border-b-2 border-[#0ea5e9] bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview
          </button>
          <button
            onClick={handleGitTab}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
              mode === 'git'
                ? 'border-b-2 border-[#4ec994] bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <GitBranch className="h-3.5 w-3.5" />
            Git
          </button>
          <button
            onClick={handleWarRoomTab}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
              mode === 'warroom'
                ? 'border-b-2 border-[#f97316] bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <Swords className="h-3.5 w-3.5" />
            War Room
          </button>
          {mode === 'git' && <RefreshButton />}
          <button
            onClick={handleClose}
            className="flex items-center px-2 text-muted-foreground hover:text-foreground"
            aria-label="Close panel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Mode content */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {mode === 'browser' && <BrowserColumn />}
          {mode === 'git' && <GitPanel />}
          {mode === 'warroom' && <WarRoomPanel />}
        </div>
      </div>
    </aside>
  )
}
