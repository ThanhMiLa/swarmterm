/**
 * Detection rules for Qwen Code, ported to TypeScript from herdr's
 * src/detect/manifests/qwen.toml (manifest version 2026.08.14.1).
 * herdr is licensed under the Apache License 2.0; this derived file is
 * modified from the original. See THIRD-PARTY-NOTICES.md at the repo root.
 *
 * Qwen Code keeps its composer visible while responding, so the prompt box is
 * not idle evidence by itself. Its status-prefixed terminal titles are the
 * primary locale-independent signals when ui.showStatusInTitle is enabled.
 * Exact screen fallbacks cover built-in locales and narrow terminals. OSC 9;4
 * is supplemental because Qwen emits it only while a tool is executing and
 * only in terminals that advertise progress support.
 */
import type { Manifest } from '@/lib/agent-state/types'

export const qwenManifest: Manifest = {
  id: 'qwen',
  herdrVersion: '2026.08.14.1',
  rules: [
    {
      id: 'osc_title_blocked',
      state: 'blocked',
      priority: 1200,
      region: 'osc_title',
      visibleBlocker: true,
      regex: [/^\u{2733}\u{FE0E}? /u]
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1100,
      region: 'osc_title',
      visibleWorking: true,
      regex: [/^\u{25D0}\u{FE0E}? /u]
    },
    {
      id: 'waiting_for_confirmation',
      state: 'blocked',
      priority: 1000,
      region: { bottomNonEmptyLines: 20 },
      visibleBlocker: true,
      lineRegex: [/^\s*⠏\s+.*\.\.\.\s*$/],
      any: [
        { contains: ['Waiting for user confirmation...'] },
        { contains: ['等待用户确认...'] },
        { contains: ['等待用戶確認...'] },
        { contains: ['Warten auf Benutzerbestätigung...'] },
        { contains: ["En attente de la confirmation de l'utilisateur..."] },
        { contains: ['ユーザーの確認を待っています...'] },
        { contains: ['Aguardando confirmação do usuário...'] },
        { contains: ['Ожидание подтверждения от пользователя...'] },
        { contains: ["Esperant la confirmació de l'usuari..."] }
      ]
    },
    {
      id: 'tool_confirmation',
      state: 'blocked',
      priority: 990,
      region: { bottomNonEmptyLines: 20 },
      visibleBlocker: true,
      contains: ['yes, allow once'],
      any: [
        { contains: ['apply this change?'] },
        { contains: ['allow execution of:'] },
        { contains: ['allow execution of mcp tool'] },
        { contains: ['do you want to proceed?'] },
        { contains: ['shell command execution'] }
      ]
    },
    {
      id: 'question_dialog',
      state: 'blocked',
      priority: 980,
      region: { bottomNonEmptyLines: 20 },
      visibleBlocker: true,
      lineRegex: [/^\s*[❯›]\s*(?:\[(?: |✓)\]\s*)?\d+\.\s+/, /^\s*↑\/↓\s*:.*(?:Enter|Return)\s*:/]
    },
    {
      id: 'folder_trust_dialog',
      state: 'blocked',
      priority: 970,
      region: { bottomNonEmptyLines: 20 },
      visibleBlocker: true,
      contains: ['do you trust this folder?', 'trust folder (', "don't trust (esc)"]
    },
    {
      id: 'cancel_hint_working',
      state: 'working',
      priority: 900,
      region: { bottomNonEmptyLines: 8 },
      visibleWorking: true,
      lineRegex: [/^\s*(?:[⠁-⣿]|\.{1,2})\s+.*\(\d+(?:m(?:\s+\d+s)?|s).*\s·\sesc to cancel\)\s*$/]
    },
    {
      id: 'narrow_cancel_hint_working',
      state: 'working',
      priority: 890,
      region: { bottomNonEmptyLines: 8 },
      visibleWorking: true,
      lineRegex: [/^\s*\(\d+(?:m(?:\s+\d+s)?|s)\s·\sesc to cancel\)\s*$/]
    },
    {
      id: 'osc_tool_progress_working',
      state: 'working',
      priority: 850,
      region: 'osc_progress',
      visibleWorking: true,
      regex: [/^4;3(?:;|$)/]
    },
    {
      id: 'composer_idle',
      state: 'idle',
      priority: 100,
      region: { bottomNonEmptyLines: 30 },
      visibleIdle: true,
      lineRegex: [/^\s*>\s*(?:type\s*)?.*$/],
      any: [
        { contains: ['type your message'] },
        { contains: ['your message or @path/to/file'] },
        { contains: ['@path/to/file'] },
        { contains: ['type', 'mes', 'sage', '@pat', 'h/to', '/fil'] }
      ]
    }
  ]
}
