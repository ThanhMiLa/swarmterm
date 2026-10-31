//! Opt-in macOS input compatibility for the main terminal WebView.
//!
//! The guarded WebKit feature is private SPI. Discover it on the installed
//! system, target only the main live preferences, and verify every write.
//! No event/focus/sleep hooks or global defaults are involved.

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputCompatibilityStatus {
    supported: bool,
    /// Last successfully saved user choice, default false.
    enabled: bool,
    /// Whether the live value matches that choice (off restores its original).
    applied: bool,
    current_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(not(target_os = "macos"))]
fn unsupported() -> InputCompatibilityStatus {
    InputCompatibilityStatus {
        supported: false,
        enabled: false,
        applied: false,
        current_enabled: None,
        error: None,
    }
}

pub fn setup(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut state = macos::STATE.lock().await;
            state.initialize(&app).await;
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub async fn get_input_compatibility(app: tauri::AppHandle) -> InputCompatibilityStatus {
    #[cfg(target_os = "macos")]
    {
        let mut state = macos::STATE.lock().await;
        state.initialize(&app).await;
        state.refresh_preference(&app).await;
        let observed = macos::observe(&app, macos::Action::Read).await;
        state.status(observed)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        unsupported()
    }
}

#[tauri::command]
pub async fn set_input_compatibility(
    app: tauri::AppHandle,
    enabled: bool,
) -> InputCompatibilityStatus {
    #[cfg(target_os = "macos")]
    {
        let mut state = macos::STATE.lock().await;
        state.initialize(&app).await;
        state.set(&app, enabled).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
        unsupported()
    }
}

#[cfg(any(target_os = "macos", test))]
mod preference_file {
    use serde::{Deserialize, Serialize};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Setting {
        enabled: bool,
    }

    pub fn read(path: &Path) -> Result<bool, String> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<Setting>(&bytes)
                .map(|setting| setting.enabled)
                .map_err(|error| format!("Cannot read input compatibility setting: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("Cannot read input compatibility setting: {error}")),
        }
    }

    pub fn write(path: &Path, enabled: bool) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or("Input compatibility setting has no parent directory")?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create app configuration directory: {error}"))?;
        let temporary = parent.join(format!(".input-compatibility-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|error| format!("Cannot save input compatibility setting: {error}"))?;
            let bytes =
                serde_json::to_vec(&Setting { enabled }).map_err(|error| error.to_string())?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("Cannot save input compatibility setting: {error}"))?;
            fs::rename(&temporary, path)
                .map_err(|error| format!("Cannot commit input compatibility setting: {error}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{preference_file, InputCompatibilityStatus};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_foundation::{NSArray, NSString};
    use std::cell::RefCell;
    use std::path::PathBuf;
    use tauri::Manager;

    const FEATURE_KEY: &str = "InputMethodUsesCorrectKeyEventOrder";
    pub(super) static STATE: tokio::sync::Mutex<State> = tokio::sync::Mutex::const_new(State {
        initialized: false,
        enabled: false,
        path: None,
        error: None,
    });

    pub(super) struct State {
        initialized: bool,
        enabled: bool,
        path: Option<PathBuf>,
        error: Option<String>,
    }

    impl State {
        pub(super) async fn initialize(&mut self, app: &tauri::AppHandle) {
            if self.initialized {
                return;
            }
            self.initialized = true;
            let path = match app.path().app_config_dir() {
                Ok(directory) => directory.join("input-compatibility.json"),
                Err(error) => {
                    self.error = Some(error.to_string());
                    return;
                }
            };
            self.path = Some(path.clone());
            match tauri::async_runtime::spawn_blocking(move || preference_file::read(&path)).await {
                Ok(Ok(enabled)) => self.enabled = enabled,
                Ok(Err(error)) => {
                    self.error = Some(error);
                    return;
                }
                Err(error) => {
                    self.error = Some(error.to_string());
                    return;
                }
            }
            // Only an explicitly saved opt-in changes the feature on startup.
            // Default-off merely captures/reads the original native value.
            let action = if self.enabled {
                Action::Set(true)
            } else {
                Action::Read
            };
            let _ = observe(app, action).await;
        }

        // Recheck file/configuration errors without reapplying a native flag.
        // Native operation errors are returned for that operation only; a later
        // successful read must not report a historical failure as current.
        pub(super) async fn refresh_preference(&mut self, app: &tauri::AppHandle) {
            if self.path.is_none() {
                match app.path().app_config_dir() {
                    Ok(directory) => self.path = Some(directory.join("input-compatibility.json")),
                    Err(error) => {
                        self.error = Some(error.to_string());
                        return;
                    }
                }
            }
            let path = self.path.clone().unwrap();
            match tauri::async_runtime::spawn_blocking(move || preference_file::read(&path)).await {
                Ok(Ok(enabled)) => {
                    self.enabled = enabled;
                    self.error = None;
                }
                Ok(Err(error)) => self.error = Some(error),
                Err(error) => self.error = Some(error.to_string()),
            }
        }

        pub(super) fn status(&self, observed: Observation) -> InputCompatibilityStatus {
            InputCompatibilityStatus {
                supported: observed.supported,
                enabled: self.enabled,
                applied: observed.supported
                    && observed
                        .current_enabled
                        .zip(observed.original_enabled)
                        .map(|(current, original)| {
                            current == if self.enabled { true } else { original }
                        })
                        .unwrap_or(false),
                current_enabled: observed.current_enabled,
                error: observed.error.or_else(|| self.error.clone()),
            }
        }

        pub(super) async fn set(
            &mut self,
            app: &tauri::AppHandle,
            enabled: bool,
        ) -> InputCompatibilityStatus {
            // A malformed/unreadable own file is not silently overwritten.
            self.refresh_preference(app).await;
            if self.error.is_some() {
                return self.status(observe(app, Action::Read).await);
            }
            let Some(path) = self.path.clone() else {
                return self.status(observe(app, Action::Read).await);
            };
            let changed = observe(app, Action::Set(enabled)).await;
            if !changed.supported || changed.error.is_some() {
                return self.status(changed);
            }
            let saved = tauri::async_runtime::spawn_blocking(move || {
                preference_file::write(&path, enabled)
            })
            .await;
            match saved {
                Ok(Ok(())) => {
                    self.enabled = enabled;
                    self.error = None;
                    self.status(changed)
                }
                failure => {
                    let error = match failure {
                        Ok(Err(error)) => error,
                        Err(error) => error.to_string(),
                        _ => unreachable!(),
                    };
                    // Do not leave a live setting that was reported as unsaved.
                    let mut restored = observe(
                        app,
                        Action::Rollback {
                            preferences_id: changed.preferences_id,
                            value: changed.previous_enabled.unwrap(),
                        },
                    )
                    .await;
                    restored.error = Some(match &restored.error {
                        Some(rollback) => format!("{error}; rollback failed: {rollback}"),
                        None => error,
                    });
                    self.status(restored)
                }
            }
        }
    }

    #[derive(Clone, Copy)]
    pub(super) enum Action {
        Read,
        Set(bool),
        Rollback { preferences_id: usize, value: bool },
    }

    pub(super) struct Observation {
        supported: bool,
        current_enabled: Option<bool>,
        original_enabled: Option<bool>,
        previous_enabled: Option<bool>,
        preferences_id: usize,
        error: Option<String>,
    }

    impl Observation {
        fn unavailable(error: impl Into<String>) -> Self {
            Self {
                supported: false,
                current_enabled: None,
                original_enabled: None,
                previous_enabled: None,
                preferences_id: 0,
                error: Some(error.into()),
            }
        }
    }

    pub(super) async fn observe(app: &tauri::AppHandle, action: Action) -> Observation {
        let Some(window) = app.get_webview_window("main") else {
            return Observation::unavailable("Main WebView is unavailable");
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        // The async state mutex is never used by this native closure, so a
        // command waiting for main-thread dispatch cannot deadlock on it.
        if let Err(error) = window.with_webview(move |platform| {
            let _ = tx.send(on_main(platform.inner().cast(), action));
        }) {
            return Observation::unavailable(error.to_string());
        }
        rx.await
            .unwrap_or_else(|error| Observation::unavailable(error.to_string()))
    }

    struct Original {
        preferences: Retained<AnyObject>,
        enabled: bool,
    }
    thread_local! {
        // Retaining the exact object prevents stale pointer identity reuse.
        static ORIGINALS: RefCell<Vec<Original>> = const { RefCell::new(Vec::new()) };
    }

    fn responds(object: &AnyObject, selector: Sel) -> bool {
        let result: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
        result.as_bool()
    }

    fn on_main(pointer: *mut AnyObject, action: Action) -> Observation {
        if MainThreadMarker::new().is_none() {
            return Observation::unavailable(
                "WebView preferences must be accessed on the main thread",
            );
        }
        // SAFETY: Tauri supplies this live WKWebView for this closure only.
        let Some(webview) = (unsafe { pointer.as_ref() }) else {
            return Observation::unavailable("Main WKWebView pointer is null");
        };
        if !responds(webview, sel!(configuration)) {
            return Observation::unavailable("WKWebView configuration is unavailable");
        }
        let configuration: Option<Retained<AnyObject>> =
            unsafe { msg_send![webview, configuration] };
        let Some(configuration) = configuration else {
            return Observation::unavailable("WKWebView has no configuration");
        };
        if !responds(&configuration, sel!(preferences)) {
            return Observation::unavailable("WKWebView preferences are unavailable");
        }
        let preferences: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*configuration, preferences] };
        let Some(preferences) = preferences else {
            return Observation::unavailable("WKWebView has no preferences");
        };
        let class = preferences.class();
        let has_catalog: Bool = unsafe { msg_send![class, respondsToSelector: sel!(_features)] };
        if !has_catalog.as_bool() || !responds(&preferences, sel!(_isEnabledForFeature:)) {
            return Observation::unavailable(
                "This WebKit does not expose input compatibility features",
            );
        }
        let catalog: Option<Retained<NSArray<AnyObject>>> = unsafe { msg_send![class, _features] };
        let Some(catalog) = catalog else {
            return Observation::unavailable("WebKit returned no feature catalog");
        };
        let mut found = None;
        for feature in catalog.iter() {
            if !responds(&feature, sel!(key)) {
                continue;
            }
            let key: Option<Retained<NSString>> = unsafe { msg_send![&*feature, key] };
            if key.as_deref().map(ToString::to_string).as_deref() == Some(FEATURE_KEY) {
                found = Some(feature);
                break;
            }
        }
        let Some(feature) = found else {
            return Observation::unavailable(
                "Input compatibility is unavailable in this WebKit version",
            );
        };
        let current: Bool = unsafe { msg_send![&*preferences, _isEnabledForFeature: &*feature] };
        let original = ORIGINALS.with(|saved| {
            let mut saved = saved.borrow_mut();
            if let Some(item) = saved
                .iter()
                .find(|item| std::ptr::eq(&*item.preferences, &*preferences))
            {
                return item.enabled;
            }
            saved.push(Original {
                preferences: preferences.clone(),
                enabled: current.as_bool(),
            });
            current.as_bool()
        });
        let mut observed = Observation {
            supported: responds(&preferences, sel!(_setEnabled:forFeature:)),
            current_enabled: Some(current.as_bool()),
            original_enabled: Some(original),
            previous_enabled: Some(current.as_bool()),
            preferences_id: (&*preferences as *const AnyObject) as usize,
            error: None,
        };
        if !observed.supported {
            observed.error =
                Some("This WebKit cannot change the input compatibility feature".into());
            return observed;
        }
        let desired = match action {
            Action::Read => return observed,
            Action::Set(enabled) => {
                if enabled {
                    true
                } else {
                    original
                }
            }
            Action::Rollback {
                preferences_id,
                value,
            } => {
                if preferences_id != observed.preferences_id {
                    observed.error =
                        Some("Main WebView preferences changed before rollback".into());
                    return observed;
                }
                value
            }
        };
        if desired != current.as_bool() {
            // SAFETY: Guarded private selector with ABI-correct BOOL and the
            // exact catalog feature; changes this main preferences instance.
            let _: () = unsafe {
                msg_send![&*preferences, _setEnabled: Bool::new(desired), forFeature: &*feature]
            };
        }
        let after: Bool = unsafe { msg_send![&*preferences, _isEnabledForFeature: &*feature] };
        observed.current_enabled = Some(after.as_bool());
        if after.as_bool() != desired {
            observed.error =
                Some("WebKit did not retain the requested input compatibility value".into());
        }
        observed
    }
}

#[cfg(test)]
mod tests {
    use super::preference_file;
    use std::fs;

    #[test]
    fn missing_setting_defaults_off_without_creating_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input-compatibility.json");
        assert!(!preference_file::read(&path).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn setting_round_trips_without_touching_other_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input-compatibility.json");
        let unrelated = directory.path().join("other.json");
        fs::write(&unrelated, b"keep exactly\n").unwrap();
        preference_file::write(&path, true).unwrap();
        assert!(preference_file::read(&path).unwrap());
        preference_file::write(&path, false).unwrap();
        assert!(!preference_file::read(&path).unwrap());
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep exactly\n");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn malformed_setting_is_reported_and_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input-compatibility.json");
        fs::write(&path, b"{\"enabled\":\"yes\"}").unwrap();
        assert!(preference_file::read(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{\"enabled\":\"yes\"}");
    }

    #[test]
    fn failed_commit_cleans_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input-compatibility.json");
        fs::create_dir(&path).unwrap();
        assert!(preference_file::write(&path, true).is_err());
        assert!(path.is_dir());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
