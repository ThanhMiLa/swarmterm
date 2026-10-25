import { useEffect, useState, type ReactElement } from 'react'
import { BarChart3, Bell, ChevronDown, ChevronRight, Keyboard, Palette, Terminal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { AppearancePanel } from './AppearancePanel'
import { TerminalPanel } from './TerminalPanel'
import { NotificationsPanel } from './NotificationsPanel'
import { KeyboardShortcutsPanel } from './KeyboardShortcutsPanel'
import { TokenUsagePanel } from './TokenUsagePanel'

export type CategoryId =
  | 'appearance'
  | 'terminal'
  | 'notifications'
  | 'shortcuts'
  | 'token-usage'

interface Category {
  id: CategoryId
  label: string
  Icon: typeof Palette
}

const CATEGORIES: Category[] = [
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
  { id: 'notifications', label: 'Notifications', Icon: Bell },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', Icon: Keyboard },
  { id: 'token-usage', label: 'Token Usage', Icon: BarChart3 },
]

interface SettingsViewProps {
  onClose: () => void
  initialCategory?: CategoryId
}

/**
 * Centered modal Settings dialog over a dimmed backdrop. A left nav rail picks
 * the active category; the right pane renders its panel. Click the backdrop,
 * press Esc, or click the close button to dismiss.
 */
export function SettingsView({ onClose, initialCategory }: SettingsViewProps): ReactElement {
  const [activeCategory, setActiveCategory] = useState<CategoryId>(initialCategory ?? 'appearance')
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    () => activeWorkspaceId || workspaces[0]?.id || ''
  )
  const [tokenUsageExpanded, setTokenUsageExpanded] = useState<boolean>(true)

  // Keep selectedWorkspaceId in sync if workspaces load/change
  const selectedWorkspace =
    workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-full max-w-6xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <nav className="flex w-56 shrink-0 flex-col border-r border-border">
          <div className="border-b border-border px-3 py-3">
            <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          </div>

          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
            {CATEGORIES.map((cat) => {
              const isTokenUsage = cat.id === 'token-usage'
              const active = cat.id === activeCategory
              const Icon = cat.Icon

              if (isTokenUsage) {
                return (
                  <div key={cat.id} className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveCategory('token-usage')
                        if (activeCategory === 'token-usage') {
                          setTokenUsageExpanded((prev) => !prev)
                        } else {
                          setTokenUsageExpanded(true)
                        }
                      }}
                      aria-pressed={active}
                      className={cn(
                        'flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
                        active
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        <span>{cat.label}</span>
                      </div>
                      {tokenUsageExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                      )}
                    </button>

                    {/* Sub-menu accordion of external workspace projects */}
                    {tokenUsageExpanded && (
                      <div className="ml-4 flex flex-col gap-0.5 border-l border-border/60 pl-2 pt-0.5 pb-1">
                        {workspaces.map((ws) => {
                          const isSelected =
                            activeCategory === 'token-usage' &&
                            selectedWorkspace?.id === ws.id
                          return (
                            <button
                              key={ws.id}
                              type="button"
                              onClick={() => {
                                setActiveCategory('token-usage')
                                setSelectedWorkspaceId(ws.id)
                              }}
                              className={cn(
                                'flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors text-left',
                                isSelected
                                  ? 'bg-accent font-medium text-accent-foreground'
                                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                              )}
                              title={ws.cwd || ws.name}
                            >
                              <span className="truncate">{ws.name}</span>
                            </button>
                          )
                        })}

                        {workspaces.length === 0 && (
                          <span className="px-2 py-1 text-[11px] text-muted-foreground italic">
                            No workspaces
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              }

              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  aria-pressed={active}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{cat.label}</span>
                </button>
              )
            })}
          </div>
        </nav>

        <div className="relative flex min-w-0 flex-1 flex-col bg-canvas">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
            className="absolute right-4 top-4 z-10 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-8 py-8">
              {activeCategory === 'appearance' && <AppearancePanel />}
              {activeCategory === 'terminal' && <TerminalPanel />}
              {activeCategory === 'notifications' && <NotificationsPanel />}
              {activeCategory === 'shortcuts' && <KeyboardShortcutsPanel />}
              {activeCategory === 'token-usage' && (
                <TokenUsagePanel selectedWorkspace={selectedWorkspace} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
