// src-tauri/src/token_usage/claude.rs
//! Claude Code session token parser.
//!
//! Scans `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl`.
//! Parses turns delimited by user messages, aggregating assistant message
//! usage and deduplicating by message id.

use super::{home_dir, mtime_ms, normalize_path, parse_iso_timestamp, PromptTurnRecord};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn default_claude_projects_root() -> Option<PathBuf> {
    let base = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))?;
    Some(base.join("projects"))
}

/// Locate all .jsonl session files under <projects_root>/*/<uuid>.jsonl
pub fn session_files(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let Ok(project_dirs) = std::fs::read_dir(root) else {
        return out;
    };
    for pdir in project_dirs.flatten() {
        if !pdir.path().is_dir() {
            continue;
        }
        let encoded_folder = pdir.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(pdir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push((path, encoded_folder.clone()));
            }
        }
    }
    out
}

#[derive(Default)]
struct AssistantUsage {
    model: String,
    input_tokens: u64,
    cache_tokens: u64,
    output_tokens: u64,
}

pub fn parse_claude_session_file(path: &Path, fallback_folder: &str) -> Vec<PromptTurnRecord> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown-session")
        .to_string();

    let mut detected_cwd = None;
    let mut turn_counter = 0usize;
    let mut turns = Vec::new();

    let mut current_turn_ts_ms = 0u64;
    let mut current_turn_date = String::new();
    let mut current_turn_id = String::new();
    let mut current_assistant_by_msg_id: HashMap<String, AssistantUsage> = HashMap::new();

    let finalize_turn = |turns: &mut Vec<PromptTurnRecord>,
                         turn_id: &str,
                         ts_ms: u64,
                         date: &str,
                         assistant_map: &HashMap<String, AssistantUsage>,
                         cwd: &str| {
        if assistant_map.is_empty() {
            return;
        }
        let mut model_counts: HashMap<String, usize> = HashMap::new();
        let mut total_in = 0u64;
        let mut total_cache = 0u64;
        let mut total_out = 0u64;

        for usage in assistant_map.values() {
            *model_counts.entry(usage.model.clone()).or_insert(0) += 1;
            total_in += usage.input_tokens;
            total_cache += usage.cache_tokens;
            total_out += usage.output_tokens;
        }

        let primary_model = model_counts
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .map(|(m, _)| m)
            .unwrap_or_else(|| "claude-default".to_string());

        let total = total_in + total_cache + total_out;
        turns.push(PromptTurnRecord {
            turn_key: format!("claude-code:{session_id}:{turn_id}"),
            agent_id: "claude-code".to_string(),
            model: primary_model,
            project_path: normalize_path(cwd),
            date: date.to_string(),
            timestamp_ms: ts_ms,
            input_tokens: total_in,
            output_tokens: total_out,
            cache_tokens: total_cache,
            total_tokens: total,
        });
    };

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if detected_cwd.is_none() {
            if let Some(cwd) = obj.get("cwd").and_then(Value::as_str) {
                detected_cwd = Some(cwd.to_string());
            }
        }

        let t = obj.get("type").and_then(Value::as_str).unwrap_or("");

        if t == "user" {
            if obj.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                continue;
            }

            // Close previous turn if it had assistant messages
            if !current_turn_id.is_empty() {
                let cwd = detected_cwd.as_deref().unwrap_or(fallback_folder);
                finalize_turn(
                    &mut turns,
                    &current_turn_id,
                    current_turn_ts_ms,
                    &current_turn_date,
                    &current_assistant_by_msg_id,
                    cwd,
                );
                current_assistant_by_msg_id.clear();
            }

            turn_counter += 1;
            current_turn_id = format!("turn-{turn_counter}");

            let ts_str = obj.get("timestamp").and_then(Value::as_str).unwrap_or("");
            let (ts_ms, date) = parse_iso_timestamp(ts_str).unwrap_or_else(|| {
                let ms = mtime_ms(path);
                (ms, super::ms_to_local_date(ms))
            });
            current_turn_ts_ms = ts_ms;
            current_turn_date = date;
        } else if t == "assistant" {
            let Some(msg) = obj.get("message") else {
                continue;
            };
            let msg_id = msg
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("msg-{turn_counter}-{}", current_assistant_by_msg_id.len()));

            let model = msg
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("claude-default")
                .to_string();

            if let Some(usage) = msg.get("usage") {
                let inp = usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
                let out = usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
                let cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let cache_create = usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let cache = cache_read + cache_create;

                current_assistant_by_msg_id.insert(
                    msg_id,
                    AssistantUsage {
                        model,
                        input_tokens: inp,
                        cache_tokens: cache,
                        output_tokens: out,
                    },
                );
            }
        }
    }

    if !current_turn_id.is_empty() {
        let cwd = detected_cwd.as_deref().unwrap_or(fallback_folder);
        finalize_turn(
            &mut turns,
            &current_turn_id,
            current_turn_ts_ms,
            &current_turn_date,
            &current_assistant_by_msg_id,
            cwd,
        );
    }

    turns
}

pub fn scan_claude(
    root: &Path,
    file_mtimes: &HashMap<String, u64>,
) -> (Vec<PromptTurnRecord>, HashMap<String, u64>) {
    let mut new_records = Vec::new();
    let mut updated_mtimes = HashMap::new();

    for (file, folder) in session_files(root) {
        let path_str = file.to_string_lossy().to_string();
        let cur_mtime = mtime_ms(&file);
        if let Some(&prev_mtime) = file_mtimes.get(&path_str) {
            if cur_mtime <= prev_mtime && cur_mtime > 0 {
                continue;
            }
        }
        let records = parse_claude_session_file(&file, &folder);
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
    fn parse_claude_aggregates_assistant_messages_per_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let sess_path = tmp.path().join("session-abc.jsonl");

        let content = concat!(
            "{\"type\":\"user\",\"cwd\":\"/Users/test/project-a\",\"timestamp\":\"2026-10-25T02:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":1000,\"output_tokens\":200,\"cache_read_input_tokens\":5000,\"cache_creation_input_tokens\":500}}}\n",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":1000,\"output_tokens\":250,\"cache_read_input_tokens\":5000,\"cache_creation_input_tokens\":500}}}\n",
        );
        fs::write(&sess_path, content).unwrap();

        let turns = parse_claude_session_file(&sess_path, "default");
        assert_eq!(turns.len(), 1);
        let t = &turns[0];
        assert_eq!(t.turn_key, "claude-code:session-abc:turn-1");
        assert_eq!(t.agent_id, "claude-code");
        assert_eq!(t.model, "claude-sonnet-4-6");
        assert_eq!(t.project_path, "/Users/test/project-a");
        assert_eq!(t.input_tokens, 1000);
        assert_eq!(t.cache_tokens, 5500);
        assert_eq!(t.output_tokens, 250);
        assert_eq!(t.total_tokens, 6750);
    }
}
