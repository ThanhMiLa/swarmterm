import { useEffect, useState, useMemo, type ReactElement } from 'react'
import { Calendar, RefreshCw, Sparkles } from 'lucide-react'
import antigravityIcon from '@/assets/agents/antigravity.svg'
import claudeIcon from '@/assets/agents/claude-code.svg'
import codexIcon from '@/assets/agents/codex.svg'
import opencodeIcon from '@/assets/agents/opencode.svg'
import { Button } from '@/components/ui/button'
import {
  getTokenUsageStats,
  onTokenUsageUpdated,
  type ModelUsageStats,
  type ProjectTokenStats,
  type TokenUsageResponse,
} from '@/tauri/token-usage'
import {
  calculateDailyCost,
  calculateModelUsageCost,
  calculateProjectAgentCosts,
  calculateProjectCost,
  formatCurrency,
} from '@/lib/token-pricing'
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
    case 'opencode':
      return { label: 'OpenCode', icon: opencodeIcon }
    default:
      return { label: agentId, icon: codexIcon }
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

export interface SelectedWorkspaceInfo {
  id: string
  name: string
  cwd: string
}

interface TokenUsagePanelProps {
  selectedWorkspace?: SelectedWorkspaceInfo | null
}

export function TokenUsagePanel({ selectedWorkspace }: TokenUsagePanelProps): ReactElement {
  const [stats, setStats] = useState<TokenUsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = async (isManual = false) => {
    if (isManual) setRefreshing(true)
    try {
      const res = await getTokenUsageStats()
      setStats(res)
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
    })
    return () => {
      unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  const currentProject = useMemo<ProjectTokenStats | null>(() => {
    if (!stats || stats.projects.length === 0) return null

    if (selectedWorkspace) {
      const normCwd = selectedWorkspace.cwd ? normalizePath(selectedWorkspace.cwd).toLowerCase() : ''
      const normName = selectedWorkspace.name.toLowerCase()

      const matched = stats.projects.find((p) => {
        const pNorm = normalizePath(p.projectPath).toLowerCase()
        if (normCwd && pNorm === normCwd) return true
        if (normName && p.projectName.toLowerCase() === normName) return true
        if (normName && pNorm.endsWith('/' + normName)) return true
        return false
      })
      if (matched) return matched
      return null
    }

    return stats.projects[0] ?? null
  }, [stats, selectedWorkspace])

  const projectCost = useMemo(() => {
    if (!currentProject) return 0
    return calculateProjectCost(currentProject)
  }, [currentProject])

  const projectAgentCosts = useMemo(() => {
    if (!currentProject) return {}
    return calculateProjectAgentCosts(currentProject)
  }, [currentProject])

  const agentCostEntries = useMemo(() => {
    return Object.entries(projectAgentCosts).filter(([, cost]) => cost > 0)
  }, [projectAgentCosts])

  const displayName = selectedWorkspace?.name || currentProject?.projectName || 'Project'

  return (
    <div className="space-y-6">
      {/* Title & Actions Bar */}
      <section className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Token Usage
          </h1>
          {selectedWorkspace && (
            <span className="rounded-full border border-border/60 bg-accent/60 px-2.5 py-0.5 text-xs font-medium text-foreground">
              {displayName}
            </span>
          )}
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

      {/* Empty state when no stats exist for this workspace */}
      {!loading && !currentProject && (
        <div className="rounded-xl border border-dashed border-border bg-card/30 p-8 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold text-foreground">
            No token activity recorded yet for{' '}
            <span className="font-mono text-foreground font-semibold">{displayName}</span>
          </h3>
          <p className="mt-1.5 text-xs text-muted-foreground max-w-md mx-auto">
            When you run prompts in <strong>Claude Code</strong>, <strong>Codex</strong>, or{' '}
            <strong>Antigravity</strong> in this workspace, token usage will automatically be tracked,
            persisted, and summarized here by Date and Model.
          </p>
        </div>
      )}

      {!loading && currentProject && (
        <>
          {/* Project Summary Overview - Tokens */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-border bg-card p-3.5">
              <span className="block text-xs font-medium text-muted-foreground">
                Total Prompts
              </span>
              <div className="mt-1">
                <span className="font-mono text-xl font-semibold text-foreground">
                  {currentProject.totalPrompts.toLocaleString()}
                </span>
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
              <span className="block text-xs font-medium text-muted-foreground">
                Cache Tokens
              </span>
              <div className="mt-1">
                <span className="font-mono text-xl font-semibold text-foreground">
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

          {/* Project Cost Breakdown by Provider (Vertical Stack) */}
          <section className="rounded-xl border border-border bg-card/60 p-4">
            <div className="flex items-center justify-between border-b border-border/80 pb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Cost Breakdown by Provider
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Total Estimated Cost:</span>
                <span className="font-mono text-base font-bold text-emerald-400">
                  {formatCurrency(projectCost)}
                </span>
              </div>
            </div>

            <div className="mt-2 divide-y divide-border/40">
              {agentCostEntries.map(([agentId, cost]) => {
                const info = getAgentInfo(agentId)
                const pct = projectCost > 0 ? ((cost / projectCost) * 100).toFixed(1) : '0'
                return (
                  <div
                    key={agentId}
                    className="flex items-center justify-between py-2.5 px-2 rounded hover:bg-accent/20 transition-colors first:pt-1 last:pb-1"
                  >
                    <div className="flex items-center gap-2.5">
                      <img src={info.icon} alt="" className="h-4 w-4 shrink-0 rounded" />
                      <span className="text-xs font-medium text-foreground">
                        {info.label} Cost
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        ({pct}%)
                      </span>
                    </div>
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {formatCurrency(cost)}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          {/* Daily Breakdown */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">
                Daily Breakdown by Model
              </h2>
            </div>

            <div className="space-y-4">
              {currentProject.dailyStats.map((day) => {
                const dayCost = calculateDailyCost(day)
                return (
                  <div
                    key={day.date}
                    className="rounded-xl border border-border bg-card/60 overflow-hidden"
                  >
                    {/* Day header banner */}
                    <div className="flex items-center justify-between border-b border-border/80 bg-accent/30 px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {day.date}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {day.promptCount} {day.promptCount === 1 ? 'prompt' : 'prompts'}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">Day Total:</span>
                          <span className="font-mono font-semibold text-orange-400">
                            {formatTokens(day.totalTokens)}
                          </span>
                        </div>
                        <span className="text-muted-foreground/40">•</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">Cost:</span>
                          <span className="font-mono font-semibold text-emerald-400">
                            {formatCurrency(dayCost)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Models breakdown table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-border/50 text-[11px] text-muted-foreground">
                            <th className="px-4 py-2 font-medium">Agent &amp; Model</th>
                            <th className="px-3 py-2 text-right font-medium">Prompts</th>
                            <th className="px-3 py-2 text-right font-medium">Input</th>
                            <th className="px-3 py-2 text-right font-medium">Output</th>
                            <th className="px-3 py-2 text-right font-medium">
                              Cache
                            </th>
                            <th className="px-3 py-2 text-right font-medium text-primary">
                              Total
                            </th>
                            <th className="px-4 py-2 text-right font-medium text-emerald-400">
                              Cost
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40 font-mono">
                          {day.models.map((m: ModelUsageStats) => {
                            const agent = getAgentInfo(m.agentId)
                            const modelCost = calculateModelUsageCost(m, day.date)
                            return (
                              <tr
                                key={`${m.agentId}:${m.model}`}
                                className="hover:bg-accent/20 transition-colors"
                              >
                                <td className="px-4 py-2.5 font-sans">
                                  <div className="flex items-center gap-2">
                                    <img
                                      src={agent.icon}
                                      alt=""
                                      className="h-4 w-4 shrink-0 rounded"
                                    />
                                    <span className="text-xs font-medium text-foreground">
                                      {agent.label}
                                    </span>
                                    <span className="text-[11px] text-muted-foreground">
                                      •
                                    </span>
                                    <span className="font-mono text-[11px] text-muted-foreground">
                                      {m.model}
                                    </span>
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-right text-muted-foreground">
                                  {m.promptCount}
                                </td>
                                <td className="px-3 py-2.5 text-right text-foreground">
                                  {formatTokens(m.inputTokens)}
                                </td>
                                <td className="px-3 py-2.5 text-right text-foreground">
                                  {formatTokens(m.outputTokens)}
                                </td>
                                <td className="px-3 py-2.5 text-right text-foreground">
                                  {formatTokens(m.cacheTokens)}
                                </td>
                                <td className="px-3 py-2.5 text-right font-semibold text-primary">
                                  {formatTokens(m.totalTokens)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-semibold text-emerald-400">
                                  {formatCurrency(modelCost)}
                                </td>
                              </tr>
                            )
                          })}

                          {/* Day subtotal row */}
                          <tr className="bg-accent/10 font-semibold text-foreground">
                            <td className="px-4 py-2 font-sans text-[11px] text-muted-foreground">
                              Daily Subtotal
                            </td>
                            <td className="px-3 py-2 text-right text-muted-foreground">
                              {day.promptCount}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatTokens(day.inputTokens)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatTokens(day.outputTokens)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {formatTokens(day.cacheTokens)}
                            </td>
                            <td className="px-3 py-2 text-right text-primary">
                              {formatTokens(day.totalTokens)}
                            </td>
                            <td className="px-4 py-2 text-right text-emerald-400">
                              {formatCurrency(dayCost)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
