// src-tauri/src/token_usage/store.rs
//! Disk cache and aggregation for token usage.
//!
//! Stores `token-usage-cache.json` in the app's config directory,
//! performs incremental scans, deduplicates prompt turns idempotently,
//! and aggregates stats by Project -> Date -> Model.

use super::{
    antigravity::scan_antigravity_roots, claude::scan_claude, codex::scan_codex_roots,
    opencode::scan_opencode, project_name_from_path, DailyUsageStats, ModelUsageStats,
    ProjectTokenStats, PromptTurnRecord, TokenUsageResponse,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const CACHE_FILE_NAME: &str = "token-usage-cache.json";
const CACHE_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DiskCache {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub turns: HashMap<String, PromptTurnRecord>,
    #[serde(default)]
    pub file_mtimes: HashMap<String, u64>,
}

pub fn load_cache(path: &Path) -> DiskCache {
    let Ok(data) = std::fs::read_to_string(path) else {
        return DiskCache {
            version: CACHE_SCHEMA_VERSION,
            ..Default::default()
        };
    };
    let mut cache: DiskCache = serde_json::from_str(&data).unwrap_or_default();
    if cache.version < CACHE_SCHEMA_VERSION {
        cache.version = CACHE_SCHEMA_VERSION;
        cache.file_mtimes.clear();
    }
    let initial_len = cache.turns.len();
    cache.turns.retain(|_, turn| {
        turn.project_path != "Unknown Workspace"
            && turn.model.len() <= 60
            && !turn.model.contains('\n')
            && !turn.model.contains('<')
    });
    if cache.turns.len() < initial_len {
        cache
            .file_mtimes
            .retain(|fpath, _| !fpath.contains("antigravity"));
    }
    cache
}

pub fn save_cache(path: &Path, cache: &DiskCache) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, json);
    }
}

pub fn aggregate_cache(cache: &DiskCache) -> TokenUsageResponse {
    // Group turns by project_path
    let mut by_project: HashMap<String, Vec<&PromptTurnRecord>> = HashMap::new();
    let mut overall_last_prompt: Option<PromptTurnRecord> = None;
    let mut total_all_tokens = 0u64;

    for turn in cache.turns.values() {
        total_all_tokens += turn.total_tokens;
        by_project
            .entry(turn.project_path.clone())
            .or_default()
            .push(turn);

        if let Some(ref cur_last) = overall_last_prompt {
            if turn.timestamp_ms > cur_last.timestamp_ms {
                overall_last_prompt = Some(turn.clone());
            }
        } else {
            overall_last_prompt = Some(turn.clone());
        }
    }

    let mut project_stats_list = Vec::new();

    for (project_path, turns) in by_project {
        let project_name = project_name_from_path(&project_path);
        let mut proj_last_prompt: Option<PromptTurnRecord> = None;
        let mut total_prompts = 0u64;
        let mut total_in = 0u64;
        let mut total_out = 0u64;
        let mut total_cache = 0u64;
        let mut total_tok = 0u64;

        // Group by Date
        let mut by_date: HashMap<String, Vec<&PromptTurnRecord>> = HashMap::new();
        for t in turns {
            total_prompts += 1;
            total_in += t.input_tokens;
            total_out += t.output_tokens;
            total_cache += t.cache_tokens;
            total_tok += t.total_tokens;

            if let Some(ref cur) = proj_last_prompt {
                if t.timestamp_ms > cur.timestamp_ms {
                    proj_last_prompt = Some((*t).clone());
                }
            } else {
                proj_last_prompt = Some((*t).clone());
            }

            by_date.entry(t.date.clone()).or_default().push(t);
        }

        let mut daily_stats = Vec::new();
        for (date, date_turns) in by_date {
            let mut date_prompts = 0u64;
            let mut date_in = 0u64;
            let mut date_out = 0u64;
            let mut date_cache = 0u64;
            let mut date_total = 0u64;

            // Group by (agent_id, model)
            let mut by_model: HashMap<(String, String), ModelUsageStats> = HashMap::new();
            for dt in date_turns {
                date_prompts += 1;
                date_in += dt.input_tokens;
                date_out += dt.output_tokens;
                date_cache += dt.cache_tokens;
                date_total += dt.total_tokens;

                let entry = by_model
                    .entry((dt.agent_id.clone(), dt.model.clone()))
                    .or_insert_with(|| ModelUsageStats {
                        agent_id: dt.agent_id.clone(),
                        model: dt.model.clone(),
                        prompt_count: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_tokens: 0,
                        total_tokens: 0,
                    });
                entry.prompt_count += 1;
                entry.input_tokens += dt.input_tokens;
                entry.output_tokens += dt.output_tokens;
                entry.cache_tokens += dt.cache_tokens;
                entry.total_tokens += dt.total_tokens;
            }

            let mut models: Vec<ModelUsageStats> = by_model.into_values().collect();
            models.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

            daily_stats.push(DailyUsageStats {
                date,
                prompt_count: date_prompts,
                input_tokens: date_in,
                output_tokens: date_out,
                cache_tokens: date_cache,
                total_tokens: date_total,
                models,
            });
        }

        // Sort dates descending (newest day first)
        daily_stats.sort_by(|a, b| b.date.cmp(&a.date));

        project_stats_list.push(ProjectTokenStats {
            project_path,
            project_name,
            total_prompts,
            total_input_tokens: total_in,
            total_output_tokens: total_out,
            total_cache_tokens: total_cache,
            total_tokens: total_tok,
            last_prompt: proj_last_prompt,
            daily_stats,
        });
    }

    // Sort projects: most recently active project first
    project_stats_list.sort_by(|a, b| {
        let ts_a = a.last_prompt.as_ref().map(|p| p.timestamp_ms).unwrap_or(0);
        let ts_b = b.last_prompt.as_ref().map(|p| p.timestamp_ms).unwrap_or(0);
        ts_b.cmp(&ts_a)
    });

    TokenUsageResponse {
        projects: project_stats_list,
        overall_last_prompt,
        total_all_tokens,
    }
}

pub fn sync_all_and_aggregate(cache_file_path: &Path) -> TokenUsageResponse {
    let mut cache = load_cache(cache_file_path);
    let mut changed = false;

    // 1. Codex (sessions + archived_sessions, .jsonl + .jsonl.zst)
    let codex_roots = super::codex::default_codex_roots();
    if !codex_roots.is_empty() {
        let (new_turns, updated_mtimes) = scan_codex_roots(&codex_roots, &cache.file_mtimes);
        if !new_turns.is_empty() || !updated_mtimes.is_empty() {
            for t in new_turns {
                cache.turns.insert(t.turn_key.clone(), t);
            }
            cache.file_mtimes.extend(updated_mtimes);
            changed = true;
        }
    }

    // 2. Claude Code
    if let Some(claude_root) = super::claude::default_claude_projects_root() {
        if claude_root.exists() {
            let (new_turns, updated_mtimes) = scan_claude(&claude_root, &cache.file_mtimes);
            if !new_turns.is_empty() || !updated_mtimes.is_empty() {
                for t in new_turns {
                    cache.turns.insert(t.turn_key.clone(), t);
                }
                cache.file_mtimes.extend(updated_mtimes);
                changed = true;
            }
        }
    }

    // 3. Antigravity (GUI + CLI + IDE)
    let agy_roots = super::antigravity::default_antigravity_roots();
    if !agy_roots.is_empty() {
        let (new_turns, updated_mtimes) = scan_antigravity_roots(&agy_roots, &cache.file_mtimes);
        if !new_turns.is_empty() || !updated_mtimes.is_empty() {
            for t in new_turns {
                cache.turns.insert(t.turn_key.clone(), t);
            }
            cache.file_mtimes.extend(updated_mtimes);
            changed = true;
        }
    }

    // 4. OpenCode (SQLite session database)
    if let Some(opencode_db) = super::opencode::default_opencode_db_path() {
        if opencode_db.exists() {
            let (new_turns, updated_mtimes) = scan_opencode(&opencode_db, &cache.file_mtimes);
            if !new_turns.is_empty() || !updated_mtimes.is_empty() {
                for t in new_turns {
                    cache.turns.insert(t.turn_key.clone(), t);
                }
                cache.file_mtimes.extend(updated_mtimes);
                changed = true;
            }
        }
    }

    if changed {
        save_cache(cache_file_path, &cache);
    }

    aggregate_cache(&cache)
}

pub fn default_cache_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(CACHE_FILE_NAME))
        .unwrap_or_else(|| {
            super::home_dir()
                .map(|h| h.join(".swarmterm").join(CACHE_FILE_NAME))
                .unwrap_or_else(|| PathBuf::from(CACHE_FILE_NAME))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_cache_groups_by_project_date_and_model() {
        let mut cache = DiskCache::default();
        cache.turns.insert(
            "t1".into(),
            PromptTurnRecord {
                turn_key: "t1".into(),
                agent_id: "codex".into(),
                model: "gpt-6.1-sol (high)".into(),
                project_path: "/repo".into(),
                date: "2026-10-25".into(),
                timestamp_ms: 1000,
                input_tokens: 100,
                output_tokens: 20,
                cache_tokens: 50,
                total_tokens: 170,
            },
        );
        cache.turns.insert(
            "t2".into(),
            PromptTurnRecord {
                turn_key: "t2".into(),
                agent_id: "codex".into(),
                model: "gpt-6.1-sol (high)".into(),
                project_path: "/repo".into(),
                date: "2026-10-25".into(),
                timestamp_ms: 2000,
                input_tokens: 200,
                output_tokens: 30,
                cache_tokens: 100,
                total_tokens: 330,
            },
        );
        cache.turns.insert(
            "t3".into(),
            PromptTurnRecord {
                turn_key: "t3".into(),
                agent_id: "claude-code".into(),
                model: "claude-sonnet-4-6".into(),
                project_path: "/repo".into(),
                date: "2026-10-24".into(),
                timestamp_ms: 500,
                input_tokens: 300,
                output_tokens: 40,
                cache_tokens: 200,
                total_tokens: 540,
            },
        );

        let res = aggregate_cache(&cache);
        assert_eq!(res.projects.len(), 1);
        let p = &res.projects[0];
        assert_eq!(p.project_path, "/repo");
        assert_eq!(p.project_name, "repo");
        assert_eq!(p.total_prompts, 3);
        assert_eq!(p.total_input_tokens, 600);
        assert_eq!(p.total_output_tokens, 90);
        assert_eq!(p.total_cache_tokens, 350);
        assert_eq!(p.total_tokens, 1040);
        assert_eq!(p.last_prompt.as_ref().unwrap().turn_key, "t2");

        assert_eq!(p.daily_stats.len(), 2);
        // Date 2026-10-25 sorts first
        assert_eq!(p.daily_stats[0].date, "2026-10-25");
        assert_eq!(p.daily_stats[0].prompt_count, 2);
        assert_eq!(p.daily_stats[0].models.len(), 1);
        assert_eq!(p.daily_stats[0].models[0].model, "gpt-6.1-sol (high)");
        assert_eq!(p.daily_stats[0].models[0].prompt_count, 2);
        assert_eq!(p.daily_stats[0].models[0].total_tokens, 500);

        assert_eq!(p.daily_stats[1].date, "2026-10-24");
        assert_eq!(p.daily_stats[1].prompt_count, 1);
        assert_eq!(p.daily_stats[1].models[0].model, "claude-sonnet-4-6");
    }
}
