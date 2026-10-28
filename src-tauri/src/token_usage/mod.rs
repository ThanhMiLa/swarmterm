// src-tauri/src/token_usage/mod.rs
//! Token usage tracking across AI coding agents (Claude Code, Codex, OpenCode, Antigravity).
//!
//! Collects per-prompt token usage (uncached input, cache, output), attributes
//! each prompt to its executing model, aggregates by Project and Date, and
//! persists an incremental cache to disk.

pub mod antigravity;
pub mod claude;
pub mod codex;
pub mod opencode;
pub mod store;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptTurnRecord {
    pub turn_key: String,
    pub agent_id: String,
    pub model: String,
    pub project_path: String,
    pub date: String,
    pub timestamp_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageStats {
    pub agent_id: String,
    pub model: String,
    pub prompt_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsageStats {
    pub date: String,
    pub prompt_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub total_tokens: u64,
    pub models: Vec<ModelUsageStats>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTokenStats {
    pub project_path: String,
    pub project_name: String,
    pub total_prompts: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_tokens: u64,
    pub total_tokens: u64,
    pub last_prompt: Option<PromptTurnRecord>,
    pub daily_stats: Vec<DailyUsageStats>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageResponse {
    pub projects: Vec<ProjectTokenStats>,
    pub overall_last_prompt: Option<PromptTurnRecord>,
    pub total_all_tokens: u64,
}

/// Convert timestamp in milliseconds to local date `YYYY-MM-DD`.
pub fn ms_to_local_date(ms: u64) -> String {
    use chrono::{Local, TimeZone};
    let secs = (ms / 1000) as i64;
    let nsecs = ((ms % 1000) * 1_000_000) as u32;
    if let Some(dt) = Local.timestamp_opt(secs, nsecs).single() {
        dt.format("%Y-%m-%d").to_string()
    } else {
        "1970-01-01".to_string()
    }
}

/// Parse RFC3339 / ISO-8601 string into `(epoch_ms, local_date_string)`.
pub fn parse_iso_timestamp(iso: &str) -> Option<(u64, String)> {
    use chrono::{DateTime, Local};
    let dt = DateTime::parse_from_rfc3339(iso).ok()?;
    let ms = dt.timestamp_millis().max(0) as u64;
    let local_dt: DateTime<Local> = DateTime::from(dt);
    let date = local_dt.format("%Y-%m-%d").to_string();
    Some((ms, date))
}

/// Normalize path for consistent comparison across operating systems.
pub fn normalize_path(path: &str) -> String {
    let p = path.replace('\\', "/");
    let trimmed = p.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// Extract clean directory name from path.
pub fn project_name_from_path(path: &str) -> String {
    let norm = path.replace('\\', "/");
    let trimmed = norm.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(path);
    if name.is_empty() {
        path.to_string()
    } else {
        name.to_string()
    }
}

pub(crate) fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

pub(crate) fn mtime_ms(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
