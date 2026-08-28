//! Per-pane context-window usage, fed by the status line's `/status` probe.
//!
//! `swarmterm --statusline` already knows the pane's `used_percentage` (Claude
//! Code hands it over on stdin every render) and already makes one loopback
//! request per render to prove the MCP link. That request now carries the
//! number as `?ctx=<pct>` — one transport, zero extra round-trips.
//!
//! The catch is *rate*: Claude re-runs the status line many times per second
//! while streaming, so forwarding every sample to the renderer would fan out a
//! Tauri event per render per Claude pane. The server therefore dedupes on the
//! ROUNDED integer and only a change becomes an `agent:context` event — the
//! chip shows whole percents anyway, so anything finer is noise.
//!
//! `None` is a distinct "no data" state, never collapsed to 0 %: a status line
//! that could not parse its stdin sends the bare path, and a session-end hook
//! publishes `None` explicitly. Both CLEAR the entry (reported once), so a
//! relaunched `claude` in the same pane never shows its predecessor's number.
//! The renderer's clear-on-exit path is belt-and-braces on top of `forget`,
//! which runs wherever the terminal leaves `AppState.terminals`.

use std::collections::HashMap;

/// Read the `ctx=` percentage off a raw `/status` query string.
///
/// Lenient on purpose. This rides the very request that decides the `mcp`
/// segment of the status line, so an axum `Query<T>` rejection would turn a
/// malformed *cosmetic* parameter into a 400 — and the pane would render
/// `mcp ✗` while its MCP link is perfectly fine. Anything unparseable is
/// simply "no data". Only the FIRST `ctx=` counts (one sender, one value; a
/// duplicate is a bug, not a vote), and only a finite value in `0..=100` is a
/// percentage — `f64::from_str` happily accepts `NaN` / `inf`, which would
/// otherwise round to garbage.
pub fn parse_ctx_query(query: Option<&str>) -> Option<f64> {
    query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("ctx="))?
        .parse::<f64>()
        .ok()
        .filter(|p| p.is_finite() && (0.0..=100.0).contains(p))
}

/// Last broadcast context percentage per terminal id, kept so a fresh sample
/// can be compared against what the renderer already shows. Entries die with
/// the PTY — see `forget`.
#[derive(Debug, Default)]
pub struct ContextUsage {
    by_id: HashMap<String, u8>,
}

impl ContextUsage {
    /// Fold one sample in and say what (if anything) to broadcast:
    /// `Some(Some(pct))` when the ROUNDED integer differs from the last one
    /// (the first sample always does), `Some(None)` when a `None` sample
    /// cleared an entry that existed, `None` when nothing changed — by far the
    /// common case, since Claude re-renders far more often than the number
    /// moves. A second `None` is silent for the same reason: the renderer
    /// already shows "no data", re-saying it is fan-out for nothing.
    ///
    /// `as u8` saturates rather than panics, so a caller that skips
    /// `parse_ctx_query`'s range filter still cannot crash the server thread.
    pub fn record(&mut self, id: &str, pct: Option<f64>) -> Option<Option<u8>> {
        let next = pct.map(|p| p.round() as u8);
        let prev = self.by_id.get(id).copied();
        if next == prev {
            return None;
        }
        match next {
            Some(v) => {
                self.by_id.insert(id.to_owned(), v);
            }
            None => {
                self.by_id.remove(id);
            }
        }
        Some(next)
    }

    /// The last broadcast integer for this pane, if it has one. Test-only
    /// observer: production reads nothing back — the renderer learns the value
    /// from the `agent:context` event, so a live accessor would be dead code.
    #[cfg(test)]
    pub fn get(&self, id: &str) -> Option<u8> {
        self.by_id.get(id).copied()
    }

    /// Drop the pane silently (no event — the terminal is leaving the map, and
    /// the renderer clears on exit itself). A same-id respawn then starts
    /// from "no data", so its first sample is a change again. Unknown ids are
    /// a no-op: `kill_terminal` and `read_loop` both call this, whichever
    /// runs second must not care.
    pub fn forget(&mut self, id: &str) {
        self.by_id.remove(id);
    }
}

/// Payload of the `agent:context` Tauri event (camelCase, lockstep with
/// `src/tauri/agent-state.ts::AgentContextEvent`). `pct: None` means the pane
/// has no context data any more — the renderer clears its chip, it never
/// shows 0 %.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextEvent {
    pub terminal_id: String,
    pub pct: Option<u8>,
    pub at_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_ctx_query ──────────────────────────────────────────────────

    #[test]
    fn no_query_is_no_data() {
        assert_eq!(parse_ctx_query(None), None);
        assert_eq!(parse_ctx_query(Some("")), None);
    }

    #[test]
    fn ctx_param_is_read_as_a_percentage() {
        assert_eq!(parse_ctx_query(Some("ctx=42.1")), Some(42.1));
        assert_eq!(parse_ctx_query(Some("foo=1&ctx=7")), Some(7.0));
    }

    #[test]
    fn first_ctx_param_wins() {
        assert_eq!(parse_ctx_query(Some("ctx=1&ctx=2")), Some(1.0));
    }

    #[test]
    fn malformed_or_non_finite_values_are_dropped() {
        assert_eq!(parse_ctx_query(Some("ctx=abc")), None);
        assert_eq!(parse_ctx_query(Some("ctx=")), None);
        assert_eq!(parse_ctx_query(Some("ctx=NaN")), None);
        assert_eq!(parse_ctx_query(Some("ctx=inf")), None);
    }

    #[test]
    fn out_of_range_values_are_dropped() {
        assert_eq!(parse_ctx_query(Some("ctx=101")), None);
        assert_eq!(parse_ctx_query(Some("ctx=-1")), None);
    }

    #[test]
    fn the_range_bounds_are_data() {
        assert_eq!(parse_ctx_query(Some("ctx=0")), Some(0.0));
        assert_eq!(parse_ctx_query(Some("ctx=100")), Some(100.0));
    }

    // ── ContextUsage ─────────────────────────────────────────────────────

    #[test]
    fn first_sample_is_a_change() {
        let mut u = ContextUsage::default();
        assert_eq!(u.record("a", Some(42.1)), Some(Some(42)));
        assert_eq!(u.get("a"), Some(42));
    }

    #[test]
    fn same_rounded_value_is_not_a_change() {
        let mut u = ContextUsage::default();
        assert_eq!(u.record("a", Some(42.1)), Some(Some(42)));
        assert_eq!(u.record("a", Some(42.4)), None);
        assert_eq!(u.record("a", Some(42.5)), Some(Some(43)));
        assert_eq!(u.get("a"), Some(43));
    }

    #[test]
    fn none_clears_and_reports_once() {
        let mut u = ContextUsage::default();
        assert_eq!(u.record("a", Some(10.0)), Some(Some(10)));
        assert_eq!(u.record("a", None), Some(None));
        assert_eq!(u.record("a", None), None);
        assert_eq!(u.get("a"), None);
    }

    #[test]
    fn none_on_an_unknown_id_is_silent() {
        let mut u = ContextUsage::default();
        assert_eq!(u.record("x", None), None);
        assert_eq!(u.get("x"), None);
    }

    #[test]
    fn forget_makes_the_next_sample_a_change() {
        let mut u = ContextUsage::default();
        assert_eq!(u.record("a", Some(10.0)), Some(Some(10)));
        u.forget("a");
        assert_eq!(u.get("a"), None);
        assert_eq!(u.record("a", Some(10.0)), Some(Some(10)));
        // Unknown id: no-op, no panic.
        u.forget("never-seen");
        assert_eq!(u.get("never-seen"), None);
    }

    #[test]
    fn ids_are_independent() {
        let mut u = ContextUsage::default();
        assert_eq!(u.record("a", Some(10.0)), Some(Some(10)));
        assert_eq!(u.record("b", Some(10.0)), Some(Some(10)));
        assert_eq!(u.record("a", Some(20.0)), Some(Some(20)));
        assert_eq!(u.get("b"), Some(10));
        assert_eq!(u.record("b", None), Some(None));
        assert_eq!(u.get("a"), Some(20));
    }

    // ── AgentContextEvent ────────────────────────────────────────────────

    #[test]
    fn event_serialises_camel_case() {
        let e = AgentContextEvent {
            terminal_id: "t".into(),
            pct: Some(42),
            at_ms: 1,
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"terminalId":"t","pct":42,"atMs":1}"#
        );
        let cleared = AgentContextEvent {
            terminal_id: "t".into(),
            pct: None,
            at_ms: 2,
        };
        assert_eq!(
            serde_json::to_string(&cleared).unwrap(),
            r#"{"terminalId":"t","pct":null,"atMs":2}"#
        );
    }
}
