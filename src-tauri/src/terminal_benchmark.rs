//! Isolated debug-only WKWebView benchmark. Never installs hooks, starts agents,
//! reads their credentials, or modifies the user's Swarmterm preferences.
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

#[tauri::command]
fn terminal_benchmark_progress(message: String) {
    eprintln!("Benchmark: {message}");
}

#[tauri::command]
fn finish_terminal_benchmark(
    app: tauri::AppHandle,
    mut report: serde_json::Value,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("benchmark") {
        report["nativeWindow"] = serde_json::json!({
            "visible": window.is_visible().ok(), "focused": window.is_focused().ok(), "minimized": window.is_minimized().ok()
        });
    }
    let path = std::env::var("SWARMTERM_BENCHMARK_REPORT").map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    eprintln!("Terminal benchmark report: {path}");
    app.exit(if report.get("error").is_some() { 1 } else { 0 });
    Ok(())
}

pub fn run(mut context: tauri::Context<tauri::Wry>) {
    assert!(
        std::env::var_os("SWARMTERM_BENCHMARK").is_some(),
        "Use npm run benchmark:terminal"
    );
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.swarmterm.benchmark".into();
    tauri::Builder::default()
        .manage(crate::pty::AppState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::create_terminal,
            crate::commands::write_terminal,
            crate::commands::write_terminal_bytes,
            crate::commands::ack_terminal_output,
            crate::commands::resize_terminal,
            crate::commands::kill_terminal,
            finish_terminal_benchmark,
            terminal_benchmark_progress,
        ])
        .setup(|app| {
            let url = if std::env::var_os("SWARMTERM_BENCHMARK_QUICK").is_some() {
                "http://localhost:1420/?terminalBenchmark=1&quick=1"
            } else {
                "http://localhost:1420/?terminalBenchmark=1"
            };
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "benchmark",
                tauri::WebviewUrl::External(url.parse().unwrap()),
            )
            .title("Swarmterm — Terminal benchmark")
            .inner_size(1200.0, 900.0)
            .visible(true)
            .focused(true)
            .always_on_top(true)
            .build()?;
            window.set_focus()?;
            Ok(())
        })
        .run(context)
        .expect("benchmark window");
}

fn emit(output: &Arc<Mutex<std::io::Stdout>>, data: &[u8]) -> bool {
    let mut out = output.lock().unwrap();
    out.write_all(data).and_then(|_| out.flush()).is_ok()
}

/// Local deterministic fixture, spawned by the normal production PTY path.
pub fn fixture(kind: &str) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("stty")
            .args(["raw", "-echo"])
            .status();
    }
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let tui = kind.starts_with("tui");
    if tui {
        emit(
            &output,
            b"\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[HBenchmark transcript\r\n",
        );
    } else {
        let mut log = String::new();
        for i in 0..5000 {
            log.push_str(&format!("\x1b[32mINFO\x1b[0m Line {i:05}: deterministic terminal fixture — Tiếng Việt 中 🚀\r\n"));
        }
        if !emit(&output, log.as_bytes()) {
            return;
        }
    }
    emit(&output, b"\x1b]777;ready\x07");
    if kind.contains("stream") {
        let output = output.clone();
        std::thread::spawn(move || {
            let line = "\x1b[36mSTREAM\x1b[0m deterministic UTF-8 data — 中 🚀 0123456789";
            let mut sequence = 0u64;
            loop {
                let mut chunk = String::new();
                for _ in 0..128 {
                    // Stress parsing/redraw without evicting the entire 5,000
                    // line history before a gesture can finish. One new row per
                    // chunk, with 128 live-line redraws like an agent's progress.
                    chunk.push_str(&format!("\r\x1b[2K{sequence:010} {line}"));
                    sequence += 1;
                }
                chunk.push_str("\r\n");
                if !emit(&output, chunk.as_bytes()) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        });
    }
    let mut pending = Vec::new();
    let mut input = [0u8; 4096];
    let mut count = 0u64;
    let mut position = 2000i64;
    loop {
        let n = match std::io::stdin().read(&mut input) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&input[..n]);
        let previous = count;
        while let Some(start) = pending.windows(3).position(|w| w == b"\x1b[<") {
            let Some(end) = pending[start..].iter().position(|c| *c == b'M') else {
                break;
            };
            let end = start + end;
            let params = String::from_utf8_lossy(&pending[start + 3..end]);
            let button = params
                .split(';')
                .next()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            if button & 64 != 0 {
                position += if button & 1 == 0 { -1 } else { 1 };
                count += 1;
            }
            pending.drain(..=end);
        }
        if pending.len() > 4096 {
            pending.clear();
        }
        if count != previous && !emit(&output, format!(
            "\x1b[H\x1b[2KPosition: {position}, reports: {count}\x1b]777;wheel:{count}:{position}\x07"
        ).as_bytes()) { break; }
    }
}
