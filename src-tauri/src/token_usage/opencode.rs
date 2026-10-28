// src-tauri/src/token_usage/opencode.rs
//! OpenCode SQLite token parser.
//!
//! OpenCode stores every session message (user + assistant) in
//! `<data-dir>/opencode.db`. Assistant messages carry the per-call `tokens`
//! object (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) and the
//! model that produced them. We aggregate those calls per user turn so the
//! panel's "prompts" count matches OpenCode's own prompt counter.
//!
//! The database is read-only and the schema is probed defensively: OpenCode's
//! schema is internal and changes between releases, so an unknown layout must
//! simply contribute no rows instead of failing the whole token-usage refresh.

use super::{home_dir, ms_to_local_date, mtime_ms, normalize_path, PromptTurnRecord};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Candidate locations for OpenCode's database, in priority order.
pub fn default_opencode_db_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(dir) = std::env::var_os("OPENCODE_DATA_DIR") {
        let dir = PathBuf::from(dir);
        candidates.push(if dir.extension().and_then(|e| e.to_str()) == Some("db") {
            dir
        } else {
            dir.join("opencode.db")
        });
    }

    if let Some(dir) = std::env::var_os("XDG_DATA_HOME") {
        candidates.push(PathBuf::from(dir).join("opencode").join("opencode.db"));
    }

    if let Some(home) = home_dir() {
        candidates.push(
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
        );
    }

    #[cfg(windows)]
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(dir).join("opencode").join("opencode.db"));
    }

    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

/// Read and aggregate OpenCode's database. `None` means the database could not
/// be opened/queried (locked, migrating, permissions) and the caller should
/// retry on the next refresh; `Some(vec![])` means the layout is unsupported
/// or has no usage yet.
pub fn parse_opencode_db(path: &Path) -> Option<Vec<PromptTurnRecord>> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(250));
    parse_opencode_connection(&conn)
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn parse_opencode_connection(conn: &Connection) -> Option<Vec<PromptTurnRecord>> {
    if !table_exists(conn, "session_v2") || !table_exists(conn, "session_message") {
        return Some(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.directory, m.id, m.type, m.time_created, m.data
             FROM session_message m
             JOIN session_v2 s ON s.id = m.session_id
             WHERE m.type IN ('user', 'assistant')
             ORDER BY s.id, m.seq",
        )
        .ok()?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .ok()?;

    struct TurnBuilder {
        turn_id: String,
        timestamp_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        cache_tokens: u64,
        total_tokens: u64,
        model_counts: HashMap<String, usize>,
    }

    impl TurnBuilder {
        fn new(turn_id: String, timestamp_ms: u64) -> Self {
            Self {
                turn_id,
                timestamp_ms,
                input_tokens: 0,
                output_tokens: 0,
                cache_tokens: 0,
                total_tokens: 0,
                model_counts: HashMap::new(),
            }
        }

        fn has_usage(&self) -> bool {
            self.total_tokens > 0
        }

        fn add_usage(&mut self, model: String, input: u64, output: u64, cache: u64) {
            *self.model_counts.entry(model).or_insert(0) += 1;
            self.input_tokens = self.input_tokens.saturating_add(input);
            self.output_tokens = self.output_tokens.saturating_add(output);
            self.cache_tokens = self.cache_tokens.saturating_add(cache);
            self.total_tokens = self
                .total_tokens
                .saturating_add(input)
                .saturating_add(output)
                .saturating_add(cache);
        }

        fn into_record(self, session_id: &str, project_path: &str) -> Option<PromptTurnRecord> {
            if !self.has_usage() {
                return None;
            }
            let model = self
                .model_counts
                .into_iter()
                .max_by_key(|(_, count)| *count)
                .map(|(model, _)| model)
                .unwrap_or_else(|| "opencode-default".to_string());
            Some(PromptTurnRecord {
                turn_key: format!("opencode:{session_id}:{}", self.turn_id),
                agent_id: "opencode".to_string(),
                model,
                project_path: normalize_path(project_path),
                date: ms_to_local_date(self.timestamp_ms),
                timestamp_ms: self.timestamp_ms,
                input_tokens: self.input_tokens,
                output_tokens: self.output_tokens,
                cache_tokens: self.cache_tokens,
                total_tokens: self.total_tokens,
            })
        }
    }

    fn model_name(data: &Value) -> String {
        let id = data
            .pointer("/model/id")
            .and_then(Value::as_str)
            .unwrap_or("opencode-default")
            .to_string();
        match data
            .pointer("/model/variant")
            .and_then(Value::as_str)
            .filter(|variant| !variant.is_empty() && *variant != "default")
        {
            Some(variant) => format!("{id} ({variant})"),
            None => id,
        }
    }

    fn usage(data: &Value) -> Option<(String, u64, u64, u64)> {
        let tokens = data.get("tokens")?;
        let input = tokens.get("input").and_then(Value::as_u64).unwrap_or(0);
        let output = tokens.get("output").and_then(Value::as_u64).unwrap_or(0);
        let reasoning = tokens.get("reasoning").and_then(Value::as_u64).unwrap_or(0);
        let cache_read = tokens
            .pointer("/cache/read")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let cache_write = tokens
            .pointer("/cache/write")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        // Reasoning tokens are billed as output by every provider OpenCode
        // exposes; keep them in the output column just like Codex/Claude.
        let output = output.saturating_add(reasoning);
        let cache = cache_read.saturating_add(cache_write);
        if input == 0 && output == 0 && cache == 0 {
            return None;
        }
        Some((model_name(data), input, output, cache))
    }

    let mut records = Vec::new();
    let mut current_session = String::new();
    let mut current_directory = String::new();
    let mut current_turn: Option<TurnBuilder> = None;

    let finalize = |turn: Option<TurnBuilder>,
                    session_id: &str,
                    directory: &str,
                    records: &mut Vec<PromptTurnRecord>| {
        if let Some(record) = turn.and_then(|t| t.into_record(session_id, directory)) {
            records.push(record);
        }
    };

    for row in rows.flatten() {
        let (session_id, directory, message_id, message_type, timestamp_ms, data) = row;
        if session_id != current_session {
            finalize(
                current_turn.take(),
                &current_session,
                &current_directory,
                &mut records,
            );
            current_session = session_id;
            current_directory = directory;
        }

        let Ok(data) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if message_type == "user" {
            // A user message closes the previous turn and starts a new one.
            finalize(
                current_turn.take(),
                &current_session,
                &current_directory,
                &mut records,
            );
            current_turn = Some(TurnBuilder::new(message_id, timestamp_ms.max(0) as u64));
            continue;
        }

        // Assistant messages without usage (aborted/errored calls) belong to
        // the current turn but contribute no tokens.
        let Some((model, input, output, cache)) = usage(&data) else {
            continue;
        };
        let turn = current_turn.get_or_insert_with(|| {
            TurnBuilder::new(format!("start-{message_id}"), timestamp_ms.max(0) as u64)
        });
        turn.add_usage(model, input, output, cache);
    }

    finalize(
        current_turn,
        &current_session,
        &current_directory,
        &mut records,
    );

    records.sort_by_key(|record| record.timestamp_ms);
    Some(records)
}

/// Scan OpenCode's database if it (or its WAL) changed since the last refresh.
pub fn scan_opencode(
    path: &Path,
    file_mtimes: &HashMap<String, u64>,
) -> (Vec<PromptTurnRecord>, HashMap<String, u64>) {
    let mut updated_mtimes = HashMap::new();
    if !path.exists() {
        return (Vec::new(), updated_mtimes);
    }

    let mut current_mtime = mtime_ms(path);
    let wal_path = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
    current_mtime = current_mtime.max(mtime_ms(&wal_path));

    let cache_key = format!("opencode-db:{}", path.to_string_lossy());
    if let Some(&previous_mtime) = file_mtimes.get(&cache_key) {
        if current_mtime > 0 && current_mtime <= previous_mtime {
            return (Vec::new(), updated_mtimes);
        }
    }

    let Some(records) = parse_opencode_db(path) else {
        // Locked/migrating database: don't record the mtime so the next
        // refresh retries instead of waiting for another write.
        return (Vec::new(), updated_mtimes);
    };

    updated_mtimes.insert(cache_key, current_mtime);
    (records, updated_mtimes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                directory TEXT NOT NULL
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                seq INTEGER NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn insert_message(
        conn: &Connection,
        id: &str,
        session_id: &str,
        message_type: &str,
        seq: i64,
        timestamp_ms: i64,
        data: Value,
    ) {
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                session_id,
                message_type,
                seq,
                timestamp_ms,
                data.to_string()
            ],
        )
        .unwrap();
    }

    #[test]
    fn aggregates_assistant_usage_per_user_turn() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO session_v2 (id, directory) VALUES ('ses_1', '/repo/demo')",
            [],
        )
        .unwrap();

        let user_ts = 1793174400000i64;
        insert_message(
            &conn,
            "msg_user_1",
            "ses_1",
            "user",
            1,
            user_ts,
            serde_json::json!({"time": {"created": user_ts}, "text": "first"}),
        );
        insert_message(
            &conn,
            "msg_assistant_1",
            "ses_1",
            "assistant",
            2,
            user_ts + 1000,
            serde_json::json!({
                "model": {"id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "max"},
                "tokens": {"input": 100, "output": 20, "reasoning": 5, "cache": {"read": 30, "write": 2}}
            }),
        );
        insert_message(
            &conn,
            "msg_assistant_2",
            "ses_1",
            "assistant",
            3,
            user_ts + 2000,
            serde_json::json!({
                "model": {"id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "max"},
                "tokens": {"input": 50, "output": 10, "reasoning": 0, "cache": {"read": 20, "write": 0}}
            }),
        );
        insert_message(
            &conn,
            "msg_user_2",
            "ses_1",
            "user",
            4,
            user_ts + 3000,
            serde_json::json!({"time": {"created": user_ts + 3000}, "text": "second"}),
        );
        insert_message(
            &conn,
            "msg_assistant_3",
            "ses_1",
            "assistant",
            5,
            user_ts + 4000,
            serde_json::json!({
                "model": {"id": "gemini-3.1-flash-lite", "providerID": "google", "variant": "default"},
                "tokens": {"input": 200, "output": 40, "reasoning": 0, "cache": {"read": 50, "write": 0}}
            }),
        );

        let records = parse_opencode_connection(&conn).unwrap();
        assert_eq!(records.len(), 2);

        let first = &records[0];
        assert_eq!(first.turn_key, "opencode:ses_1:msg_user_1");
        assert_eq!(first.agent_id, "opencode");
        assert_eq!(first.model, "deepseek-v4.1-flash-free (max)");
        assert_eq!(first.project_path, "/repo/demo");
        assert_eq!(first.timestamp_ms, user_ts as u64);
        assert_eq!(first.input_tokens, 150);
        assert_eq!(first.output_tokens, 35); // output + reasoning
        assert_eq!(first.cache_tokens, 52); // read + write
        assert_eq!(first.total_tokens, 237);

        let second = &records[1];
        assert_eq!(second.turn_key, "opencode:ses_1:msg_user_2");
        assert_eq!(second.model, "gemini-3.1-flash-lite");
        assert_eq!(second.input_tokens, 200);
        assert_eq!(second.output_tokens, 40);
        assert_eq!(second.cache_tokens, 50);
        assert_eq!(second.total_tokens, 290);
    }

    #[test]
    fn ignores_messages_without_usage_and_unknown_schema() {
        let conn = test_connection();
        conn.execute(
            "INSERT INTO session_v2 (id, directory) VALUES ('ses_1', '/repo/demo')",
            [],
        )
        .unwrap();
        insert_message(
            &conn,
            "msg_user_1",
            "ses_1",
            "user",
            1,
            1000,
            serde_json::json!({"time": {"created": 1000}}),
        );
        insert_message(
            &conn,
            "msg_assistant_1",
            "ses_1",
            "assistant",
            2,
            2000,
            serde_json::json!({"model": {"id": "m"}, "tokens": {"input": 0, "output": 0}}),
        );

        assert!(parse_opencode_connection(&conn).unwrap().is_empty());

        let empty = Connection::open_in_memory().unwrap();
        assert!(parse_opencode_connection(&empty).unwrap().is_empty());
    }
}
