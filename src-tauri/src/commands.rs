use portable_pty::PtySize;
use std::io::Write;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pty::{AppState, CreateTerminalOptions, CreateTerminalResult, PtyOut};

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    options: CreateTerminalOptions,
    on_data: Channel<PtyOut>,
) -> CreateTerminalResult {
    crate::pty::spawn_terminal(&app, &state, id, options, on_data)
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    id: String,
    data: String,
    input_token: Option<String>,
) -> Result<(), String> {
    write_input(&state, &id, data.into_bytes(), input_token).await
}

#[tauri::command]
pub async fn write_terminal_bytes(
    state: State<'_, AppState>,
    id: String,
    bytes: Vec<u8>,
    input_token: Option<String>,
) -> Result<(), String> {
    write_input(&state, &id, bytes, input_token).await
}

async fn write_input(
    state: &AppState,
    id: &str,
    bytes: Vec<u8>,
    input_token: Option<String>,
) -> Result<(), String> {
    // Never hold the terminal map or the UI thread while a PTY write waits for
    // its child. ACK, resize and kill must remain available under backpressure.
    let writer = state
        .terminals
        .lock()
        .unwrap()
        .get(id)
        .filter(|t| t.input_token == input_token)
        .map(|t| t.writer.clone());
    if let Some(writer) = writer {
        tauri::async_runtime::spawn_blocking(move || {
            let mut writer = writer.lock().map_err(|e| e.to_string())?;
            for chunk in bytes.chunks(4096) {
                writer.write_all(chunk).map_err(|e| e.to_string())?;
            }
            writer.flush().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[tauri::command]
pub fn ack_terminal_output(
    state: State<'_, AppState>,
    id: String,
    flow_id: u64,
    processed_bytes: u64,
) {
    crate::pty::ack_terminal_output(&state, &id, flow_id, processed_bytes);
}

#[tauri::command]
pub fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) {
    if let Some(t) = state.terminals.lock().unwrap().get(&id) {
        let _ = t.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

#[tauri::command]
pub fn kill_terminal(app: AppHandle, state: State<'_, AppState>, id: String) {
    // Take the terminal OUT of the map so its master PTY handle is dropped here,
    // rather than lingering until the reader thread cleans up. This makes the
    // reader observe EOF promptly on every platform:
    //   - Windows (ConPTY): killing the child does NOT close the output pipe while
    //     the master handle lives, so the reader would park on read() forever.
    //     Dropping the master runs ClosePseudoConsole, which closes the pipe.
    //   - Unix (macOS/Linux): the child's death already closes the slave, so the
    //     reader's own dup'd fd sees EOF regardless; dropping this master fd early
    //     is harmless.
    // Either way the reader then breaks, read_loop emits Exit and frees the id —
    // which a same-id respawn (agent/cwd/shell switch) waits for before spawning.
    //
    // The `let` binding releases the map lock BEFORE the kill/drop, so the reader
    // thread can re-lock the map to clear the id without deadlocking.
    let removed = state.terminals.lock().unwrap().remove(&id);
    if let Some(mut t) = removed {
        t.kill();
        // Dropping `t` (and its master PTY) at end of scope forces the reader's EOF.
    }
    // A dead pane must not linger as a War Room ghost: peers would still see
    // it in list_peers and queue messages for a terminal that can never read
    // them. leave_everywhere() is idempotent, so racing read_loop's cleanup
    // is harmless.
    let left = state
        .war_rooms
        .lock()
        .unwrap()
        .leave_everywhere(&id, crate::warroom::now_ms());
    if let Some((room_id, event)) = left {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
    }
    // A dead pane's preview must not linger as an orphaned native webview
    // painting over nothing. Idempotent with the renderer's GC sweep and with
    // read_loop below — whoever runs second finds the label gone.
    //
    // Closing the webview here is a Rust-side event the renderer's own
    // setup/cleanup effects never see (this can fire on a same-id respawn or
    // an agent/cwd/shell switch, not just a pane close), so emit preview:closed
    // to fold it into browser-store — otherwise the address bar shows a stale
    // preview and the next preview_open recreates the webview hidden with no
    // effect re-run left to show it.
    if let Some(webview) = app.get_webview(&crate::preview::preview_label(&id)) {
        let _ = webview.close();
        let _ = app.emit(
            "preview:closed",
            &crate::preview::PreviewClosedEvent {
                terminal_id: id.clone(),
            },
        );
    }
    // A respawned pane reuses its id, so a stale `connected` verdict would
    // survive into the new shell and hide the very failure the status line
    // exists to show. Drop it here and in `read_loop`, mirroring the two
    // places the terminal leaves `AppState.terminals`.
    state.mcp_clients.lock().unwrap().forget(&id);
    // The context chip too: a respawned Claude must not inherit the old %.
    state.context_usage.lock().unwrap().forget(&id);
    // Same for the agent-state mirror + screen tail: a respawn must start
    // from `unknown`, and a `wait_peer` sleeper on this id must wake now to
    // see the peer gone rather than run out its timeout.
    state.peer_states.lock().unwrap().forget(&id);
    state.peer_wake.notify_waiters();
}

/// Renderer → Rust mirror of a pane's agent display state (`working` /
/// `blocked` / `idle` / `done` / `unknown`), fed by `lib/agent-state-mirror`.
/// Rust cannot derive this itself (the heuristics run over xterm's buffer in
/// the renderer), and the M2 `war_room.wait_peer` / `read_peer` verbs must
/// answer without a renderer round-trip — see `mcp::peer_state`.
#[tauri::command]
pub fn report_agent_state(app: AppHandle, state: State<'_, AppState>, id: String, display: String) {
    // Only live terminals may be written. A report can race a kill (the
    // store's diff fires after `kill_terminal` already ran `forget`), and
    // accepting it would resurrect a row for a dead pty that nothing will
    // ever clean up again. The two locks are taken SEQUENTIALLY — check
    // `terminals`, drop it, then lock `peer_states` — never nested, per the
    // own-lock rule on `AppState`.
    let live = state.terminals.lock().unwrap().contains_key(&id);
    if !live {
        return;
    }
    let changed =
        state
            .peer_states
            .lock()
            .unwrap()
            .set_state(&id, &display, crate::warroom::now_ms());
    if changed {
        state.peer_wake.notify_waiters();
    }

    if display == "done" || display == "idle" {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            let cache_path = crate::token_usage::store::default_cache_path(&handle);
            let res = tokio::task::spawn_blocking(move || {
                crate::token_usage::store::sync_all_and_aggregate(&cache_path)
            })
            .await;
            if let Ok(stats) = res {
                let _ = handle.emit("token-usage:updated", stats);
            }
        });
    }
}

#[tauri::command]
pub fn list_available_shells() -> Vec<crate::shell::ShellEntry> {
    crate::shell::list_shells().to_vec()
}

#[tauri::command]
pub fn list_available_agents() -> Vec<crate::agents::AgentEntry> {
    crate::agents::list_agents()
}

#[tauri::command]
pub async fn list_agent_sessions(folder: String) -> Vec<crate::sessions::SessionEntry> {
    crate::sessions::list_all(folder).await
}

/// Install or remove Claude Code's `statusLine` entry. Driven from the renderer
/// (on boot and on toggle) rather than from Rust's `setup`, because the
/// preference lives in localStorage and only the renderer can read it. That
/// ordering is fine: the status line only matters once a Claude pane exists,
/// which is strictly after the renderer has mounted.
#[tauri::command]
pub fn set_claude_statusline(app: AppHandle, enabled: bool) -> Result<(), String> {
    crate::statusline::install::apply(&app, enabled)
}

#[tauri::command]
pub async fn git_list_worktrees(
    app: AppHandle,
    cwd: String,
) -> Result<Vec<crate::git::WorktreeInfo>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::list_worktrees(std::path::Path::new(&cwd), &home)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_get_changed_files(
    worktree_path: String,
) -> Result<Vec<crate::git::ChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::get_changed_files(std::path::Path::new(&worktree_path))
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_get_file_diff(worktree_path: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::get_file_diff(std::path::Path::new(&worktree_path), &file)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_get_commit_info(worktree_path: String) -> Result<crate::git::CommitInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::get_commit_info(std::path::Path::new(&worktree_path))
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branch_unmerged_count(repo_root: String, branch: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::branch_unmerged_count(std::path::Path::new(&repo_root), &branch)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_merge_readiness(
    repo_root: String,
    branch: String,
) -> Result<crate::git::MergeReadiness, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::merge_readiness(std::path::Path::new(&repo_root), &branch)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_create_worktree(
    repo_root: String,
    branch: String,
) -> Result<crate::git::CreatedWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::create_worktree(std::path::Path::new(&repo_root), &branch)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[tauri::command]
pub async fn git_clear_worktree(
    repo_root: String,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::clear_worktree(
            std::path::Path::new(&repo_root),
            std::path::Path::new(&worktree_path),
            &branch,
        )
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

/// Ensure a directory is a git repository with at least one commit.
/// Frontend calls this during workspace creation when isolate=true and the
/// folder is not yet a git repo. `home` is resolved here (like git_list_worktrees)
/// so the backend can ignore a repo that merely contains the folder.
#[tauri::command]
pub async fn ensure_repo_with_commit(app: AppHandle, path: String) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::ensure_repo_with_commit(std::path::Path::new(&path), &home)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve a path candidate the renderer found in terminal output. Returns the
/// canonical path as a string, or `None` when it does not name an existing file
/// — in which case the renderer does not draw a link.
#[tauri::command]
pub fn resolve_path_link(cwd: String, candidate: String) -> Option<String> {
    crate::links::resolve_candidate(std::path::Path::new(&cwd), &candidate)
        .map(|p| p.to_string_lossy().into_owned())
}

/// First of `candidates` (an allowlisted editor id) found on PATH. The renderer
/// asks once and caches; `None` means fall back to revealing in the file manager.
#[tauri::command]
pub fn find_available_editor(candidates: Vec<String>) -> Option<String> {
    let allowed: Vec<String> = candidates
        .into_iter()
        .filter(|c| crate::links::is_allowed_editor(c))
        .collect();
    let path_var = std::env::var("PATH").unwrap_or_default();
    crate::links::find_editor(&path_var, &allowed)
}

/// Launch an editor by argv. Never goes through a shell, so nothing in `args`
/// can be reinterpreted as shell syntax, and `bin` is re-checked against the
/// allowlist because the renderer is not a trust boundary.
#[tauri::command]
pub fn open_in_editor(bin: String, args: Vec<String>) -> Result<(), String> {
    if !crate::links::is_allowed_editor(&bin) {
        return Err(format!("editor not allowed: {bin}"));
    }
    std::process::Command::new(&bin)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Show the file in the OS file manager. Used when no allowlisted editor is on
/// PATH. Reveal-only: the file is selected, never opened, so this can't execute
/// anything.
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{path}"));
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut cmd = {
        // No portable "reveal" on Linux; open the containing directory instead.
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        let mut c = std::process::Command::new("xdg-open");
        c.arg(parent);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Frontend drags a pane into one room's drop zone. Metadata is a frontend
/// snapshot: the leaf's explicit agentId and the registry's live cwd — the
/// Rust terminal map deliberately stores neither. Joining room X while
/// already a member of room Y moves it: `WarRooms::join` leaves Y first.
#[tauri::command]
pub fn war_room_join(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
    terminal_id: String,
    agent_id: Option<String>,
    cwd: String,
    display_name: String,
) -> Result<(), String> {
    // TOCTOU: this liveness check and the `war_rooms.join` insert below take
    // two separate mutexes with no lock held across both, so a pane that dies
    // in the gap between them still gets inserted as a member. Accepted: it's
    // recoverable via the chip's ✕ / leave, and the alternative (a single
    // lock spanning both maps) isn't worth the coupling for a rare, low-cost
    // race — leaves a ghost member, not a stuck or corrupted state.
    if !state.terminals.lock().unwrap().contains_key(&terminal_id) {
        return Err(format!("terminal \"{terminal_id}\" is not live"));
    }
    // Without the MCP server the room's tools are unreachable — joining would
    // look successful while nothing works. Fail loudly instead (spec §failure
    // modes); the renderer logs it and the pane simply doesn't join.
    if state.mcp_url.get().is_none() {
        return Err("MCP server failed to start this run — War Room is unavailable".into());
    }
    let outcome = state.war_rooms.lock().unwrap().join(
        &room_id,
        terminal_id,
        agent_id,
        cwd,
        display_name,
        crate::warroom::now_ms(),
    )?;
    // Old room's Leave first, then the Join — the renderer's queue cleanup
    // must run before the new membership appears.
    if let Some((old_room, ev)) = outcome.left {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&old_room, ev));
    }
    let _ = app.emit(
        "warroom:event",
        &crate::warroom::scoped(&room_id, outcome.joined),
    );
    Ok(())
}

/// Full rooms snapshot for renderer hydration (boot / dev reload).
#[tauri::command]
pub fn war_room_rooms(state: State<'_, AppState>) -> Vec<crate::warroom::RoomInfo> {
    state.war_rooms.lock().unwrap().rooms_info()
}

#[tauri::command]
pub fn war_room_leave(app: AppHandle, state: State<'_, AppState>, terminal_id: String) {
    let left = state
        .war_rooms
        .lock()
        .unwrap()
        .leave_everywhere(&terminal_id, crate::warroom::now_ms());
    if let Some((room_id, event)) = left {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
    }
}

#[tauri::command]
pub fn war_room_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<crate::warroom::RoomMeta, String> {
    let (meta, rooms) = {
        let mut reg = state.war_rooms.lock().unwrap();
        let meta = reg.create(&name)?;
        (meta, reg.rooms_meta())
    };
    let _ = app.emit("warroom:rooms", &rooms);
    Ok(meta)
}

#[tauri::command]
pub fn war_room_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
    name: String,
) -> Result<(), String> {
    let rooms = {
        let mut reg = state.war_rooms.lock().unwrap();
        reg.rename(&room_id, &name)?;
        reg.rooms_meta()
    };
    let _ = app.emit("warroom:rooms", &rooms);
    Ok(())
}

#[tauri::command]
pub fn war_room_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
) -> Result<(), String> {
    let (leaves, rooms) = {
        let mut reg = state.war_rooms.lock().unwrap();
        let leaves = reg.delete(&room_id, crate::warroom::now_ms())?;
        (leaves, reg.rooms_meta())
    };
    // Leaves first (queue/held cleanup per member), snapshot last (tab strip).
    for ev in leaves {
        let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, ev));
    }
    let _ = app.emit("warroom:rooms", &rooms);
    Ok(())
}

/// The user speaking as the Moderator of ONE room, from that room's composer.
/// Same lock-then-emit discipline; error strings surface inline in the composer.
#[tauri::command]
pub fn war_room_moderator_send(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
    to: Option<String>,
    content: String,
    mode: Option<String>,
) -> Result<usize, String> {
    let mode = crate::warroom::MessageMode::parse(mode.as_deref())?;
    let (event, deliveries) = {
        let mut reg = state.war_rooms.lock().unwrap();
        let entry = reg
            .get(&room_id)
            .ok_or_else(|| format!("no such room \"{room_id}\""))?;
        let out = entry.room.send(
            crate::warroom::MODERATOR_ID,
            to.as_deref(),
            &content,
            mode,
            crate::warroom::now_ms(),
        )?;
        (out.event, out.deliveries)
    };
    let delivered = deliveries.len();
    let _ = app.emit("warroom:event", &crate::warroom::scoped(&room_id, event));
    for d in deliveries {
        let _ = app.emit("warroom:deliver", &d);
    }
    Ok(delivered)
}

#[tauri::command]
pub async fn get_token_usage_stats(
    app: AppHandle,
) -> Result<crate::token_usage::TokenUsageResponse, String> {
    let cache_path = crate::token_usage::store::default_cache_path(&app);
    tokio::task::spawn_blocking(move || {
        crate::token_usage::store::sync_all_and_aggregate(&cache_path)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod terminal_io_tests {
    use super::*;
    use crate::pty::{FlowController, ManagedTerminal, MAX_UNACKED_BYTES};
    use portable_pty::{native_pty_system, ChildKiller};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    struct BlockedWriter(Arc<(Mutex<bool>, Condvar)>);
    impl Write for BlockedWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let (lock, wake) = &*self.0;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[derive(Debug)]
    struct NoopKiller;
    impl ChildKiller for NoopKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(NoopKiller)
        }
    }

    #[tokio::test]
    async fn blocked_pty_input_does_not_block_ack_or_terminal_management() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(Box::new(BlockedWriter(gate.clone()))));
        let flow = FlowController::new(999);
        assert!(flow.wait_for_credit(MAX_UNACKED_BYTES));
        let state = Arc::new(AppState::default());
        state.terminals.lock().unwrap().insert(
            "blocked".into(),
            ManagedTerminal {
                input_token: None,
                writer: writer.clone(),
                master: pair.master,
                killer: Box::new(NoopKiller),
                #[cfg(windows)]
                job: None,
                worktree_mode: false,
                repo_root: None,
                flow: flow.clone(),
            },
        );
        let input_state = state.clone();
        let input = tokio::spawn(async move {
            write_input(&input_state, "blocked", vec![b'x'; 8192], None).await
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        let blocked = writer.try_lock().is_err();
        let ack_state = state.clone();
        let ack = tokio::task::spawn_blocking(move || {
            crate::pty::ack_terminal_output(&ack_state, "blocked", 999, 32768)
        });
        let ack_result = tokio::time::timeout(Duration::from_millis(500), ack).await;
        // Release before asserting so even a regression cannot strand the test worker.
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        let write_result = tokio::time::timeout(Duration::from_secs(2), input).await;
        assert!(blocked, "fixture must exercise a blocked writer");
        assert!(
            ack_result.is_ok(),
            "ACK must not wait for the PTY writer's mutex"
        );
        assert!(write_result.is_ok());
        assert_eq!(flow.inner.0.lock().unwrap().total_acked_bytes, 32768);
        assert!(state.terminals.lock().unwrap().remove("blocked").is_some());
    }

    #[tokio::test]
    async fn stale_input_cannot_reach_a_replacement_session() {
        struct Recorder(Arc<Mutex<Vec<u8>>>);
        impl Write for Recorder {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let state = AppState::default();
        state.terminals.lock().unwrap().insert(
            "reused-id".into(),
            ManagedTerminal {
                input_token: Some("new-session".into()),
                writer: Arc::new(Mutex::new(Box::new(Recorder(recorded.clone())))),
                master: pair.master,
                killer: Box::new(NoopKiller),
                #[cfg(windows)]
                job: None,
                worktree_mode: false,
                repo_root: None,
                flow: FlowController::new(1000),
            },
        );
        write_input(
            &state,
            "reused-id",
            b"stale".to_vec(),
            Some("old-session".into()),
        )
        .await
        .unwrap();
        write_input(&state, "reused-id", b"missing-token".to_vec(), None)
            .await
            .unwrap();
        assert!(recorded.lock().unwrap().is_empty());
        write_input(
            &state,
            "reused-id",
            b"fresh".to_vec(),
            Some("new-session".into()),
        )
        .await
        .unwrap();
        assert_eq!(*recorded.lock().unwrap(), b"fresh");
    }
}
