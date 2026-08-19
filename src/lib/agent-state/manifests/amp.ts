/**
 * Detection rules for Amp, ported to TypeScript from herdr's
 * src/detect/manifests/amp.toml (manifest version 2026.07.09.1).
 * herdr is licensed under the Apache License 2.0; this derived file is
 * modified from the original. See THIRD-PARTY-NOTICES.md at the repo root.
 *
 * Amp's OSC title is the strongest signal: a braille-spinner prefix while
 * working, a "Plugin confirmation needed" title while blocked, and a
 * " - amp - " title otherwise (proven idle). Screen rules back those up.
 */
import type { Manifest } from '@/lib/agent-state/types'

const AMP_BRAILLE_TITLE = /^[\u{2800}-\u{28FF}] /u

export const ampManifest: Manifest = {
  id: 'amp',
  herdrVersion: '2026.07.09.1',
  rules: [
    {
      id: 'osc_title_plugin_confirmation_blocked',
      state: 'blocked',
      priority: 1100,
      region: 'osc_title',
      visibleBlocker: true,
      contains: ['Plugin confirmation needed']
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1050,
      region: 'osc_title',
      visibleWorking: true,
      regex: [AMP_BRAILLE_TITLE]
    },
    {
      id: 'approval_footer',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        { contains: ['waiting for approval'] },
        { contains: ['invoke tool'] },
        { contains: ['run this command?'] },
        { contains: ['allow editing file:'] },
        { contains: ['allow creating file:'] },
        { contains: ['confirm tool call'] },
        {
          contains: ['approve'],
          any: [
            { contains: ['allow all for this session'] },
            { contains: ['allow all for every session'] },
            { contains: ['allow file for every session'] },
            { contains: ['deny with feedback'] }
          ]
        }
      ]
    },
    {
      id: 'status_footer_working',
      state: 'working',
      priority: 200,
      region: { bottomNonEmptyLines: 5 },
      visibleWorking: true,
      lineRegex: [/^\s*╰\s+\S+\s+(thinking|streaming|running tools|waiting)\s+─/i]
    },
    {
      id: 'esc_cancel_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      contains: ['esc to cancel']
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 50,
      region: 'osc_title',
      visibleIdle: true,
      contains: [' - amp - '],
      not: [{ regex: [AMP_BRAILLE_TITLE] }, { contains: ['Plugin confirmation needed'] }]
    }
  ]
}
