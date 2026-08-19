/**
 * Detection rules for Cursor Agent, ported to TypeScript from herdr's
 * src/detect/manifests/cursor.toml (manifest version 2026.08.03.1).
 * herdr is licensed under the Apache License 2.0; this derived file is
 * modified from the original. See THIRD-PARTY-NOTICES.md at the repo root.
 */
import type { Manifest } from '@/lib/agent-state/types'

export const cursorManifest: Manifest = {
  id: 'cursor',
  herdrVersion: '2026.08.03.1',
  rules: [
    {
      id: 'write_file_approval',
      state: 'blocked',
      priority: 320,
      region: { bottomNonEmptyLines: 8 },
      visibleBlocker: true,
      contains: ['write to this file?', 'proceed (y)'],
      any: [
        { contains: ['reject & propose changes'] },
        { contains: ['esc or n or p'] },
        { contains: ['add write('] }
      ]
    },
    {
      id: 'approval_prompt',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      any: [
        {
          contains: ['waiting for approval', 'run this command?'],
          any: [{ contains: ['run (once) (y)'] }, { contains: ['skip (esc or n)'] }]
        },
        { contains: ['(y) (enter)'] },
        { lineRegex: [/^\s*allow .*\(y\)/i] },
        { contains: ['keep (n)'] },
        { contains: ['skip (esc or n)'] },
        { lineRegex: [/^\s*(?:→\s*)?run .*\(y\)/i] }
      ]
    },
    {
      id: 'stop_hint_working',
      state: 'working',
      priority: 100,
      region: { bottomNonEmptyLines: 6 },
      visibleWorking: true,
      contains: ['ctrl+c to stop']
    },
    {
      id: 'background_task_status_working',
      state: 'working',
      priority: 95,
      region: { bottomNonEmptyLines: 5 },
      visibleWorking: true,
      lineRegex: [/\b[1-9][0-9]*\s+background\s+tasks?\b/i]
    },
    {
      id: 'spinner_working',
      state: 'working',
      priority: 90,
      region: { bottomNonEmptyLines: 8 },
      visibleWorking: true,
      lineRegex: [/^\s*(⬡|⬢|[\u{2800}-\u{28FF}]+)\s+\p{Alphabetic}+\w*ing\b/u]
    }
  ]
}
