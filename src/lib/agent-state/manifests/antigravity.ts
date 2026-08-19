/**
 * Detection rules for Antigravity, ported to TypeScript from herdr's
 * src/detect/manifests/antigravity.toml (manifest version 2026.06.24.1).
 * herdr keys this manifest `agy` (the binary); ours is keyed by the
 * workspace template id `antigravity` — the registry convention.
 * herdr is licensed under the Apache License 2.0; this derived file is
 * modified from the original. See THIRD-PARTY-NOTICES.md at the repo root.
 */
import type { Manifest } from '@/lib/agent-state/types'

export const antigravityManifest: Manifest = {
  id: 'antigravity',
  herdrVersion: '2026.06.24.1',
  rules: [
    {
      id: 'permission_prompt',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['requesting permission for:'],
      any: [{ contains: ['do you want to proceed?'] }, { contains: ['tab amend', 'edit command'] }]
    },
    {
      id: 'spinner_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      lineRegex: [/^\s*[\u{2800}-\u{28FF}]+\s+\p{Alphabetic}+\w*ing\b/u]
    },
    {
      id: 'background_tasks_working',
      state: 'working',
      priority: 90,
      region: { bottomNonEmptyLines: 5 },
      visibleWorking: true,
      lineRegex: [/·\s*[1-9][0-9]*\s+task/i]
    }
  ]
}
