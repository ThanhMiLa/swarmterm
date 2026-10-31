import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { isMacPlatform } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  getInputCompatibility,
  setInputCompatibility,
  type InputCompatibilityStatus
} from '@/tauri/input-compatibility'

/** The native setting affects the entire app, including ordinary text fields. */
export function InputCompatibilitySetting(): ReactElement | null {
  return isMacPlatform() ? <MacInputCompatibilitySetting /> : null
}

function MacInputCompatibilitySetting(): ReactElement {
  const [status, setStatus] = useState<InputCompatibilityStatus | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const pending = useRef(false)
  const request = useRef(0)

  const update = useCallback(async (nextEnabled?: boolean): Promise<void> => {
    if (!mounted.current || pending.current) return
    pending.current = true
    const currentRequest = ++request.current
    setBusy(true)
    setError(null)
    try {
      const next = nextEnabled === undefined
        ? await getInputCompatibility()
        : await setInputCompatibility(nextEnabled)
      if (!mounted.current || request.current !== currentRequest) return
      setStatus(next)
      if (next.error || (next.supported && !next.applied)) {
        setError(nextEnabled === undefined
          ? "Couldn't confirm OpenKey compatibility. Check again or try changing this setting."
          : "Couldn't update OpenKey compatibility. Check again to see its current state.")
      }
    } catch {
      if (!mounted.current || request.current !== currentRequest) return
      setError(nextEnabled === undefined
        ? "Couldn't load OpenKey compatibility. Try again."
        : "Couldn't update OpenKey compatibility. Check again to see its current state.")
    } finally {
      if (mounted.current && request.current === currentRequest) {
        pending.current = false
        setBusy(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void update()
    return () => {
      mounted.current = false
      pending.current = false
      ++request.current
    }
  }, [update])

  // The control edits the backend's saved choice, including when applying that
  // choice failed. The separate status below reports whether it is active.
  const enabled = status?.enabled ?? false

  return (
    <section className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="input-compatibility-label" className="text-sm font-semibold text-foreground">
            OpenKey compatibility
          </h2>
          <p id="input-compatibility-description" className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Use this if Vietnamese accents disappear while typing with OpenKey.
            Applies to text fields throughout Swarmterm.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="input-compatibility-label"
          aria-describedby={status?.supported && !status.applied
            ? 'input-compatibility-description input-compatibility-state'
            : 'input-compatibility-description'}
          disabled={busy || !status?.supported}
          onClick={() => void update(!enabled)}
          className={cn(
            'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
            enabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform',
              enabled ? 'left-0.5 translate-x-4' : 'left-0.5'
            )}
          />
        </button>
      </div>

      {status?.supported && !status.applied && (
        <p id="input-compatibility-state" role="status" className="mt-3 text-xs text-muted-foreground">
          Saved choice: {enabled ? 'On' : 'Off'}. This choice isn't currently applied.
        </p>
      )}
      {busy && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {status ? 'Updating…' : 'Loading…'}
        </p>
      )}
      {!busy && status?.supported === false && !error && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          This option isn't available on this Mac.
        </p>
      )}
      {error && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p role="alert" className="text-xs leading-relaxed text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void update()}>
            Check again
          </Button>
        </div>
      )}
    </section>
  )
}
