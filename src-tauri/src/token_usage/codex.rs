// src-tauri/src/token_usage/codex.rs
//! Codex CLI rollout token parser.
//!
//! Scans `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`.
//! Reads `turn_context` for model and reasoning effort, and `token_usage_record`
//! for input/cached/output tokens.

use super::{home_dir, mtime_ms, normalize_path, parse_iso_timestamp, PromptTurnRecord};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn default_codex_sessions_root() -> Option<PathBuf> {
    let base = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))?;
    Some(base.join("sessions"))
}

/// Recursively locate all rollout-*.jsonl under YYYY/MM/DD.
pub fn rollout_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let years = std::fs::read_dir(root).map(|r| r.flatten().collect::<Vec<_>>());
    for year in years.unwrap_or_default() {
        let months = std::fs::read_dir(year.path()).map(|r| r.flatten().collect::<Vec<_>>());
        for month in months.unwrap_or_default() {
            let days = std::fs::read_dir(month.path()).map(|r| r.flatten().collect::<Vec<_>>());
            for day in days.unwrap_or_default() {
                let leaves = std::fs::read_dir(day.path()).map(|r| r.flatten().collect::<Vec<_>>());
                for f in leaves.unwrap_or_default() {
                    let p = f.path();
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        files.push(p);
                    }
                }
            }
        }
    }
    files
}

/// Parse one Codex rollout file into a list of prompt turns.
pub fn parse_rollout_file(path: &Path) -> Vec<PromptTurnRecord> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines = content.lines();

    let Some(first_line) = lines.next() else {
        return Vec::new();
    };
    let Ok(meta) = serde_json::from_str::<Value>(first_line) else {
        return Vec::new();
    };
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Vec::new();
    }
    let Some(payload) = meta.get("payload") else {
        return Vec::new();
    };
    let Some(session_id) = payload.get("id").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(cwd) = payload.get("cwd").and_then(Value::as_str) else {
        return Vec::new();
    };
    if payload.get("source").and_then(Value::as_str) == Some("exec") {
        return Vec::new();
    }

    let project_path = normalize_path(cwd);

    let mut models_by_turn: HashMap<String, String> = HashMap::new();
    struct IntermediateTurn {
        timestamp_ms: u64,
        date: String,
        input_tokens: u64,
        cache_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    }
    let mut turns_by_id: HashMap<String, IntermediateTurn> = HashMap::new();

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let t = obj.get("type").and_then(Value::as_str).unwrap_or("");
        let Some(p) = obj.get("payload") else {
            continue;
        };

        if t == "turn_context" {
            let Some(turn_id) = p.get("turn_id").and_then(Value::as_str) else {
                continue;
            };
            let mut model = p
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("codex-default")
                .to_string();
            let effort = p
                .get("collaboration_mode")
                .and_then(|cm| cm.get("settings"))
                .and_then(|s| s.get("reasoning_effort"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !effort.is_empty() && effort != "default" {
                model = format!("{model} ({effort})");
            }
            models_by_turn.insert(turn_id.to_string(), model);
        } else if t == "token_usage_record" {
            let Some(turn_id) = p.get("turn_id").and_then(Value::as_str) else {
                continue;
            };
            let u = p.get("turn_token_usage").or_else(|| p.get("usage"));
            let Some(usage) = u else {
                continue;
            };

            let raw_input = usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
            let cached_in = usage
                .get("cached_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cache_write = usage
                .get("cache_write_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cache_tokens = cached_in + cache_write;
            let input_tokens = raw_input.saturating_sub(cache_tokens);
            let output_tokens = usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
            let total_tokens = input_tokens + cache_tokens + output_tokens;

            let ts_str = obj.get("timestamp").and_then(Value::as_str).unwrap_or("");
            let (timestamp_ms, date) = parse_iso_timestamp(ts_str).unwrap_or_else(|| {
                let ms = mtime_ms(path);
                (ms, super::ms_to_local_date(ms))
            });

            turns_by_id.insert(
                turn_id.to_string(),
                IntermediateTurn {
                    timestamp_ms,
                    date,
                    input_tokens,
                    cache_tokens,
                    output_tokens,
                    total_tokens,
                },
            );
        }
    }

    let mut out = Vec::new();
    for (turn_id, turn) in turns_by_id {
        let model = models_by_turn
            .remove(&turn_id)
            .unwrap_or_else(|| "codex-default".to_string());
        out.push(PromptTurnRecord {
            turn_key: format!("codex:{session_id}:{turn_id}"),
            agent_id: "codex".to_string(),
            model,
            project_path: project_path.clone(),
            date: turn.date,
            timestamp_ms: turn.timestamp_ms,
            input_tokens: turn.input_tokens,
            output_tokens: turn.output_tokens,
            cache_tokens: turn.cache_tokens,
            total_tokens: turn.total_tokens,
        });
    }

    out.sort_by_key(|r| r.timestamp_ms);
    out
}

/// Scan for new or modified Codex rollouts given previous file mtimes.
pub fn scan_codex(
    root: &Path,
    file_mtimes: &HashMap<String, u64>,
) -> (Vec<PromptTurnRecord>, HashMap<String, u64>) {
    let mut new_records = Vec::new();
    let mut updated_mtimes = HashMap::new();

    for file in rollout_files(root) {
        let path_str = file.to_string_lossy().to_string();
        let cur_mtime = mtime_ms(&file);
        if let Some(&prev_mtime) = file_mtimes.get(&path_str) {
            if cur_mtime <= prev_mtime && cur_mtime > 0 {
                continue;
            }
        }
        let records = parse_rollout_file(&file);
        new_records.extend(records);
        updated_mtimes.insert(path_str, cur_mtime);
    }

    (new_records, updated_mtimes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_rollout_calculates_uncached_input_and_extracts_model() {
        let tmp = tempfile::tempdir().unwrap();
        let rollout_path = tmp.path().join("rollout-2026-10-25.jsonl");

        let content = concat!(
            "{\"timestamp\":\"2026-10-25T01:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"sess-123\",\"cwd\":\"/Users/test/my-project\",\"source\":\"cli\"}}\n",
            "{\"timestamp\":\"2026-10-25T01:00:01.000Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"turn-1\",\"model\":\"gpt-6.1-sol\",\"collaboration_mode\":{\"settings\":{\"reasoning_effort\":\"high\"}}}}\n",
            "{\"timestamp\":\"2026-10-25T01:00:05.000Z\",\"type\":\"token_usage_record\",\"payload\":{\"turn_id\":\"turn-1\",\"turn_token_usage\":{\"input_tokens\":17287,\"cached_input_tokens\":13056,\"cache_write_input_tokens\":0,\"output_tokens\":220,\"total_tokens\":17507}}}\n",
        );
        fs::write(&rollout_path, content).unwrap();

        let turns = parse_rollout_file(&rollout_path);
        assert_eq!(turns.len(), 1);
        let t = &turns[0];
        assert_eq!(t.turn_key, "codex:sess-123:turn-1");
        assert_eq!(t.agent_id, "codex");
        assert_eq!(t.model, "gpt-6.1-sol (high)");
        assert_eq!(t.project_path, "/Users/test/my-project");
        assert_eq!(t.input_tokens, 4231); // 17287 - 13056
        assert_eq!(t.cache_tokens, 13056);
        assert_eq!(t.output_tokens, 220);
        assert_eq!(t.total_tokens, 17507);
        assert_eq!(t.input_tokens + t.cache_tokens + t.output_tokens, t.total_tokens);
    }
}
