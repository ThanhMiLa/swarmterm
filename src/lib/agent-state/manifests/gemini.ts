/**
 * Detection rules for Gemini CLI, ported to TypeScript from herdr's
 * src/detect/manifests/gemini.toml (manifest version 2026.06.10.1).
 * herdr is licensed under the Apache License 2.0; this derived file is
 * modified from the original. See THIRD-PARTY-NOTICES.md at the repo root.
 */
import type { Manifest } from '@/lib/agent-state/types'

export const geminiManifest: Manifest = {
  id: 'gemini',
  herdrVersion: '2026.06.10.1',
  rules: [
    {
      id: 'apply_or_allow_change',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        { contains: ['│ Apply this change'] },
        { contains: ['│ Allow execution'] },
        {
          all: [
            { contains: ['yes'] },
            {
              any: [
                { contains: ['waiting for user confirmation'] },
                { contains: ['│ Do you want to proceed'] },
                { contains: ['do you want to proceed?'] }
              ]
            }
          ]
        },
        { lineRegex: [/^\s*❯.*(yes|allow)/i] }
      ]
    },
    {
      id: 'esc_cancel_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      contains: ['esc to cancel']
    }
  ]
}
