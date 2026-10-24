import { useEffect, useState, useMemo, type ReactElement } from 'react'
import { Calendar, RefreshCw, Sparkles } from 'lucide-react'
import antigravityIcon from '@/assets/agents/antigravity.svg'
import claudeIcon from '@/assets/agents/claude-code.svg'
import codexIcon from '@/assets/agents/codex.svg'
import { Button } from '@/components/ui/button'
import {
  getTokenUsageStats,
  onTokenUsageUpdated,
  type ModelUsageStats,
  type ProjectTokenStats,
  type TokenUsageResponse,
} from '@/tauri/token-usage'
import { cn } from '@/lib/utils'

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return (count / 1_000_000).toFixed(2) + 'M'
  }
  if (count >= 1_000) {
    return (count / 1_000).toFixed(1) + 'k'
  }
  return count.toLocaleString()
}

function getAgentInfo(agentId: string): { label: string; icon: string } {
  switch (agentId) {
    case 'codex':
      return { label: 'Codex', icon: codexIcon }
    case 'claude-code':
      return { label: 'Claude Code', icon: claudeIcon }
    case 'antigravity':
      return { label: 'Antigravity', icon: antigravityIcon }
    default:
      return { label: agentId, icon: codexIcon }
  }
}

export function TokenUsagePanel(): ReactElement {
  const [stats, setStats] = useState<TokenUsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedProject, setSelectedProject] = useState<string>('')

  const loadData = async (isManual = false) => {
    if (isManual) setRefreshing(true)
    try {
      const res = await getTokenUsageStats()
      setStats(res)
      setSelectedProject((prev) => {
        if (prev && res.projects.some((p) => p.projectPath === prev)) {
          return prev
        }
        return res.projects[0]?.projectPath ?? ''
      })
    } catch (err) {
      console.error('Failed to load token usage stats:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()
    const unlistenPromise = onTokenUsageUpdated((updated) => {
      setStats(updated)
      setSelectedProject((prev) => {
        if (prev && updated.projects.some((p) => p.projectPath === prev)) {
          return prev
        }
        return updated.projects[0]?.projectPath ?? ''
      })
    })
    return () => {
      unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  const currentProject = useMemo<ProjectTokenStats | null>(() => {
    if (!stats || stats.projects.length === 0) return null
    return (
      stats.projects.find((p) => p.projectPath === selectedProject) ??
      stats.projects[0] ??
      null
    )
  }, [stats, selectedProject])

  return (
    <div className="space-y-6">
      {/* Title & Filter Bar */}
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Token Usage
        </h1>

        <div className="flex items-center gap-2.5">
          {/* Project selector (Single project only) */}
          <div className="relative">
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              disabled={loading || !stats || stats.projects.length === 0}
              className="h-8 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            >
              {stats?.projects.map((p) => (
                <option key={p.projectPath} value={p.projectPath}>
                  {p.projectName} ({formatTokens(p.totalTokens)})
                </option>
              ))}
            </select>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            title="Refresh token data"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            <span>Refresh</span>
          </Button>
        </div>
      </section>

      {/* Loading state */}
      {loading && (
        <div className="flex h-48 items-center justify-center rounded-xl border border-border bg-card/50">
          <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin text-primary" />
            <span>Scanning session token records...</span>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && (!stats || stats.projects.length === 0) && (
        <div className="rounded-xl border border-dashed border-border bg-card/30 p-8 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold text-foreground">
            No token activity recorded yet
          </h3>
          <p className="mt-1.5 text-xs text-muted-foreground max-w-md mx-auto">
            When you run prompts in <strong>Claude Code</strong>, <strong>Codex</strong>, or{' '}
            <strong>Antigravity</strong>, token usage will automatically be tracked,
            persisted, and summarized here by Project and Date.
          </p>
        </div>
      )}

      {!loading && currentProject && (
        <>
          {/* Project Summary Overview */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-border bg-card p-3.5">
              <span className="block text-xs font-medium text-muted-foreground">
                Total Prompts
              </span>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="font-mono text-xl font-semibold text-foreground">
                  {currentProject.totalPrompts.toLocaleString()}
                </span>
                <span className="text-[11px] text-muted-foreground">prompts</span>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-3.5">
              <span className="block text-xs font-medium text-muted-foreground">
                Input Tokens
              </span>
              <div className="mt-1">
                <span className="font-mono text-xl font-semibold text-foreground">
                  {formatTokens(currentProject.totalInputTokens)}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-3.5">
              <span className="block text-xs font-medium text-muted-foreground">
                Output Tokens
              </span>
              <div className="mt-1">
                <span className="font-mono text-xl font-semibold text-foreground">
                  {formatTokens(currentProject.totalOutputTokens)}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-3.5">
              <span className="block text-xs font-medium text-emerald-400">
                Cache Tokens
              </span>
              <div className="mt-1">
                <span className="font-mono text-xl font-semibold text-emerald-400">
                  {formatTokens(currentProject.totalCacheTokens)}
                </span>
              </div>
            </div>

            <div className="col-span-2 rounded-xl border border-border bg-card p-3.5 sm:col-span-1">
              <span className="block text-xs font-medium text-primary">
                Total Tokens
              </span>
              <div className="mt-1">
                <span className="font-mono text-xl font-semibold text-primary">
                  {formatTokens(currentProject.totalTokens)}
                </span>
              </div>
            </div>
          </section>

          {/* Daily Breakdown by Model */}
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Calendar className="h-4 w-4 text-primary" />
              <span>Daily Breakdown by Model</span>
            </h2>

            {currentProject.dailyStats.length === 0 ? (
              <p className="text-xs text-muted-foreground">No daily data available.</p>
            ) : (
              <div className="space-y-4">
                {currentProject.dailyStats.map((day) => (
                  <div
                    key={day.date}
                    className="overflow-hidden rounded-xl border border-border bg-card"
                  >
                    {/* Day header */}
                    <div className="flex flex-wrap items-center justify-between border-b border-border bg-accent/30 px-4 py-2.5">
                      <div className="flex items-center gap-2 font-mono text-xs font-semibold text-foreground">
                        <Calendar className="h-3.5 w-3.5 text-primary" />
                        <span>{day.date}</span>
                        <span className="rounded bg-accent/80 px-1.5 py-0.2 text-[11px] font-normal text-muted-foreground">
                          {day.promptCount} {day.promptCount === 1 ? 'prompt' : 'prompts'}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 font-mono text-xs">
                        <span className="text-muted-foreground">
                          Day Total:{' '}
                          <strong className="text-foreground">{formatTokens(day.totalTokens)}</strong>
                        </span>
                      </div>
                    </div>

                    {/* Table of Models */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-border/40 text-[11px] font-medium text-muted-foreground">
                            <th className="px-4 py-2">Agent & Model</th>
                            <th className="px-3 py-2 text-right">Prompts</th>
                            <th className="px-3 py-2 text-right">Input</th>
                            <th className="px-3 py-2 text-right">Output</th>
                            <th className="px-3 py-2 text-right">Cache</th>
                            <th className="px-4 py-2 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/20 font-mono">
                          {day.models.map((m: ModelUsageStats) => {
                            const agent = getAgentInfo(m.agentId)
                            return (
                              <tr
                                key={`${m.agentId}-${m.model}`}
                                className="transition-colors hover:bg-accent/20"
                              >
                                <td className="flex items-center gap-2 px-4 py-2.5 font-sans">
                                  <img
                                    src={agent.icon}
                                    alt=""
                                    className="h-4 w-4 shrink-0 object-contain"
                                  />
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-medium text-foreground">
                                      {agent.label}
                                    </span>
                                    <span className="text-muted-foreground">•</span>
                                    <span className="rounded bg-accent/40 px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
                                      {m.model}
                                    </span>
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-right font-sans text-muted-foreground">
                                  {m.promptCount}
                                </td>
                                <td className="px-3 py-2.5 text-right text-foreground">
                                  {formatTokens(m.inputTokens)}
                                </td>
                                <td className="px-3 py-2.5 text-right text-foreground">
                                  {formatTokens(m.outputTokens)}
                                </td>
                                <td className="px-3 py-2.5 text-right text-emerald-400">
                                  {formatTokens(m.cacheTokens)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-semibold text-primary">
                                  {formatTokens(m.totalTokens)}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-border bg-accent/10 font-mono text-[11px] font-semibold text-foreground">
                            <td className="px-4 py-2 font-sans">Daily Subtotal</td>
                            <td className="px-3 py-2 text-right font-sans text-muted-foreground">
                              {day.promptCount}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatTokens(day.inputTokens)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatTokens(day.outputTokens)}
                            </td>
                            <td className="px-3 py-2 text-right text-emerald-400">
                              {formatTokens(day.cacheTokens)}
                            </td>
                            <td className="px-4 py-2 text-right text-primary">
                              {formatTokens(day.totalTokens)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
