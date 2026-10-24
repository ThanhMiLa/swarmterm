// src-tauri/src/token_usage/antigravity.rs
//! Antigravity transcript token parser.
//!
//! Scans `~/.gemini/antigravity/brain/<conv_id>/.system_generated/logs/transcript.jsonl`.
//! Maps conversation_id to project workspace via conversation_summaries.db,
//! extracts active Model from `<USER_SETTINGS_CHANGE>`, and aggregates PLANNER_RESPONSE tokens.

use super::{home_dir, mtime_ms, normalize_path, parse_iso_timestamp, PromptTurnRecord};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn default_antigravity_roots() -> Vec<PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let gemini = home.join(".gemini");
    vec![
        gemini.join("antigravity"),
        gemini.join("antigravity-cli"),
        gemini.join("antigravity-ide"),
    ]
}

/// Read workspace mappings from both `cache/last_conversations.json` and `conversation_summaries.db`.
pub fn load_workspace_mappings_for_root(root: &Path, map: &mut HashMap<String, String>) {
    // 1. Read cache/last_conversations.json: { "/path/to/project": "conversation-id" }
    let last_conv_path = root.join("cache").join("last_conversations.json");
    if let Ok(content) = std::fs::read_to_string(&last_conv_path) {
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&content) {
            for (proj_path, val) in obj {
                if let Some(cid) = val.as_str() {
                    map.insert(cid.to_string(), normalize_path(&proj_path));
                }
            }
        }
    }

    // 2. Query conversation_summaries.db via sqlite3
    let db_path = root.join("conversation_summaries.db");
    if !db_path.exists() {
        return;
    }

    let output = std::process::Command::new("sqlite3")
        .args([
            "-json",
            &db_path.to_string_lossy(),
            "SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE workspace_uris IS NOT NULL AND workspace_uris != '[]'",
        ])
        .output();

    let Ok(out) = output else {
        return;
    };
    if !out.status.success() {
        return;
    }

    let Ok(json_str) = std::str::from_utf8(&out.stdout) else {
        return;
    };
    let Ok(rows) = serde_json::from_str::<Value>(json_str) else {
        return;
    };
    let Some(arr) = rows.as_array() else {
        return;
    };

    for row in arr {
        let Some(cid) = row.get("conversation_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(uris_str) = row.get("workspace_uris").and_then(Value::as_str) else {
            continue;
        };
        let Ok(uris) = serde_json::from_str::<Value>(uris_str) else {
            continue;
        };
        if let Some(first_uri) = uris.as_array().and_then(|a| a.first()).and_then(Value::as_str) {
            if let Ok(parsed) = url::Url::parse(first_uri) {
                if let Ok(file_path) = parsed.to_file_path() {
                    map.insert(cid.to_string(), normalize_path(&file_path.to_string_lossy()));
                }
            }
        }
    }
}

/// Extract model name from `<USER_SETTINGS_CHANGE>` text.
pub fn extract_model_name(content: &str) -> Option<String> {
    // 1. Isolate the <USER_SETTINGS_CHANGE>...</USER_SETTINGS_CHANGE> block first
    // so we never accidentally match text from the user prompt!
    let block = if let Some(start) = content.find("<USER_SETTINGS_CHANGE>") {
        let after = &content[start + "<USER_SETTINGS_CHANGE>".len()..];
        if let Some(end) = after.find("</USER_SETTINGS_CHANGE>") {
            &after[..end]
        } else {
            after
        }
    } else if content.contains("Model Selection") {
        content
    } else {
        return None;
    };

    if !block.contains("Model Selection") {
        return None;
    }

    let model_sel_idx = block.find("Model Selection")?;
    let after_sel = &block[model_sel_idx..];

    let to_idx = after_sel.find(" to ")?;
    let after_to = &after_sel[to_idx + 4..];

    let candidate = if let Some(idx) = after_to.find(". No need") {
        &after_to[..idx]
    } else if let Some(idx) = after_to.find(".\n") {
        &after_to[..idx]
    } else if let Some(idx) = after_to.find('\n') {
        &after_to[..idx]
    } else {
        after_to.trim_end_matches('.')
    };

    let trimmed = candidate.trim().trim_matches('`').trim();
    if !trimmed.is_empty() && trimmed.len() < 60 && !trimmed.contains('\n') && !trimmed.contains('<') {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Parse one Antigravity transcript.jsonl file into PromptTurnRecords.
pub fn parse_antigravity_transcript(
    path: &Path,
    conversation_id: &str,
    project_path: &str,
) -> Vec<PromptTurnRecord> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    let mut current_model = "Gemini Default".to_string();
    let mut turns = Vec::new();

    let mut current_step_index = 0u64;
    let mut current_ts_ms = 0u64;
    let mut current_date = String::new();
    let mut current_input = 0u64;
    let mut current_cache = 0u64;
    let mut current_output = 0u64;
    let mut in_turn = false;

    let finalize_turn = |turns: &mut Vec<PromptTurnRecord>,
                         step_idx: u64,
                         ts_ms: u64,
                         date: &str,
                         model: &str,
                         inp: u64,
                         cache: u64,
                         out: u64| {
        let total = inp + cache + out;
        if total == 0 {
            return;
        }
        turns.push(PromptTurnRecord {
            turn_key: format!("antigravity:{conversation_id}:step:{step_idx}"),
            agent_id: "antigravity".to_string(),
            model: model.to_string(),
            project_path: project_path.to_string(),
            date: date.to_string(),
            timestamp_ms: ts_ms,
            input_tokens: inp,
            output_tokens: out,
            cache_tokens: cache,
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
        let t = obj.get("type").and_then(Value::as_str).unwrap_or("");

        if t == "USER_INPUT" {
            let content_str = obj.get("content").and_then(Value::as_str).unwrap_or("");
            if let Some(new_model) = extract_model_name(content_str) {
                current_model = new_model;
            }

            if in_turn {
                finalize_turn(
                    &mut turns,
                    current_step_index,
                    current_ts_ms,
                    &current_date,
                    &current_model,
                    current_input,
                    current_cache,
                    current_output,
                );
            }

            current_step_index = obj.get("step_index").and_then(Value::as_u64).unwrap_or(0);
            let ts_str = obj.get("created_at").and_then(Value::as_str).unwrap_or("");
            let (ts_ms, date) = parse_iso_timestamp(ts_str).unwrap_or_else(|| {
                let ms = mtime_ms(path);
                (ms, super::ms_to_local_date(ms))
            });
            current_ts_ms = ts_ms;
            current_date = date;
            current_input = 0;
            current_cache = 0;
            current_output = 0;
            in_turn = true;
        } else if t == "PLANNER_RESPONSE" && in_turn {
            current_input += obj.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
            current_cache += obj.get("cache_read_tokens").and_then(Value::as_u64).unwrap_or(0);
            current_output += obj.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
            if current_ts_ms == 0 {
                let ts_str = obj.get("created_at").and_then(Value::as_str).unwrap_or("");
                if let Some((ts_ms, date)) = parse_iso_timestamp(ts_str) {
                    current_ts_ms = ts_ms;
                    current_date = date;
                }
            }
        }
    }

    if in_turn {
        finalize_turn(
            &mut turns,
            current_step_index,
            current_ts_ms,
            &current_date,
            &current_model,
            current_input,
            current_cache,
            current_output,
        );
    }

    turns
}

pub fn scan_antigravity_roots(
    roots: &[PathBuf],
    file_mtimes: &HashMap<String, u64>,
) -> (Vec<PromptTurnRecord>, HashMap<String, u64>) {
    let mut new_records = Vec::new();
    let mut updated_mtimes = HashMap::new();

    // Build unified workspace map across all Antigravity roots (GUI + CLI + IDE)
    let mut workspace_map = HashMap::new();
    for root in roots {
        if root.exists() {
            load_workspace_mappings_for_root(root, &mut workspace_map);
        }
    }

    for root in roots {
        let brain_dir = root.join("brain");
        let Ok(conversations) = std::fs::read_dir(&brain_dir) else {
            continue;
        };

        for convo in conversations.flatten() {
            if !convo.path().is_dir() {
                continue;
            }
            let cid = convo.file_name().to_string_lossy().to_string();
            let transcript_path = convo
                .path()
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");

            if !transcript_path.exists() {
                continue;
            }

            let path_str = transcript_path.to_string_lossy().to_string();
            let cur_mtime = mtime_ms(&transcript_path);
            if let Some(&prev_mtime) = file_mtimes.get(&path_str) {
                if cur_mtime <= prev_mtime && cur_mtime > 0 {
                    continue;
                }
            }

            let Some(project_path) = workspace_map.get(&cid) else {
                // Skip caching mtime if workspace mapping is not written yet so next scan picks it up
                continue;
            };

            let records = parse_antigravity_transcript(&transcript_path, &cid, project_path);
            new_records.extend(records);
            updated_mtimes.insert(path_str, cur_mtime);
        }
    }

    (new_records, updated_mtimes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_model_name_parses_selection_change() {
        let content = "The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change if the user doesn't ask about it.";
        assert_eq!(
            extract_model_name(content),
            Some("Gemini 3.8 Flash (High)".to_string())
        );

        let content2 = "The user changed setting `Model Selection` from Gemini 3.8 Flash (High) to Gemini 4 Argon (Medium). No need to comment...";
        assert_eq!(
            extract_model_name(content2),
            Some("Gemini 4 Argon (Medium)".to_string())
        );

        // Crucial test: User request text containing "to " must NEVER be matched as model name!
        let full_user_input = concat!(
            "<USER_REQUEST>\n",
            "Please help me to change the authenticated user's password. - [] Extract the authenticated user ID.\n",
            "</USER_REQUEST>\n",
            "<USER_SETTINGS_CHANGE>\n",
            "The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment...\n",
            "</USER_SETTINGS_CHANGE>"
        );
        assert_eq!(
            extract_model_name(full_user_input),
            Some("Gemini 3.8 Flash (High)".to_string())
        );
    }

    #[test]
    fn parse_transcript_groups_tokens_under_active_model() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("transcript.jsonl");

        let content = concat!(
            "{\"step_index\":0,\"type\":\"USER_INPUT\",\"created_at\":\"2026-10-25T01:00:00Z\",\"content\":\"<USER_SETTINGS_CHANGE>\\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (High). No need to comment...\\n</USER_SETTINGS_CHANGE>\"}\n",
            "{\"step_index\":1,\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-10-25T01:00:05Z\",\"input_tokens\":5000,\"cache_read_tokens\":10000,\"output_tokens\":300}\n",
            "{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-10-25T01:00:10Z\",\"input_tokens\":1000,\"cache_read_tokens\":12000,\"output_tokens\":200}\n",
        );
        std::fs::write(&file_path, content).unwrap();

        let turns = parse_antigravity_transcript(&file_path, "conv-1", "/Users/test/swarmterm");
        assert_eq!(turns.len(), 1);
        let t = &turns[0];
        assert_eq!(t.turn_key, "antigravity:conv-1:step:0");
        assert_eq!(t.agent_id, "antigravity");
        assert_eq!(t.model, "Gemini 4 Argon (High)");
        assert_eq!(t.project_path, "/Users/test/swarmterm");
        assert_eq!(t.input_tokens, 6000);
        assert_eq!(t.cache_tokens, 22000);
        assert_eq!(t.output_tokens, 500);
        assert_eq!(t.total_tokens, 28500);
    }
}
