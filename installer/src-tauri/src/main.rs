// Reliquary client web installer.
// Fetches the latest release from GitHub, downloads its NSIS installer, and runs
// it silently (elevated) into the chosen directory — the Tauri window is the only
// UI the user sees. Running the real NSIS installer (vs. unzipping) keeps the
// install consistent with the app's in-app electron-updater.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

const REPO: &str = "HPelto/Reliquary";

#[derive(Serialize, Clone)]
struct ReleaseInfo {
    version: String,
    url: String,
    size: u64,
    /// Base64 SHA-512 of the installer, taken from the release's `latest.yml`.
    /// The download is refused if its hash doesn't match this. This is the same
    /// checksum the in-app electron-updater verifies, so first-install and
    /// auto-update share one source of truth.
    sha512: String,
}

/// Pull the top-level `path:` and `sha512:` out of electron-builder's
/// `latest.yml`. Those two keys are at column 0; the per-file copies under
/// `files:` are indented, so `strip_prefix` (which requires an exact start)
/// matches only the authoritative top-level values.
fn parse_latest_yml(yml: &str) -> Option<(String, String)> {
    let mut path = None;
    let mut sha = None;
    for line in yml.lines() {
        if let Some(rest) = line.strip_prefix("path:") {
            path = Some(rest.trim().trim_matches(['\'', '"']).to_string());
        } else if let Some(rest) = line.strip_prefix("sha512:") {
            sha = Some(rest.trim().to_string());
        }
    }
    match (path, sha) {
        (Some(p), Some(s)) if !p.is_empty() && !s.is_empty() => Some((p, s)),
        _ => None,
    }
}

/// Default install location: Program Files (x86)\ReliquaryApp.
#[tauri::command]
fn default_dir() -> String {
    let pf = std::env::var("ProgramFiles(x86)")
        .or_else(|_| std::env::var("ProgramFiles"))
        .unwrap_or_else(|_| "C:\\Program Files (x86)".into());
    format!("{}\\ReliquaryApp", pf)
}

/// Ask GitHub for the newest release and find its Windows installer asset.
#[tauri::command]
fn fetch_latest() -> Result<ReleaseInfo, String> {
    let api = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = ureq::get(&api)
        .set("User-Agent", "Reliquary-Installer")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    let body: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;

    let version = body["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let assets = body["assets"]
        .as_array()
        .ok_or("No published release found yet.")?;

    // latest.yml is the publisher's manifest: it names the exact installer file
    // and carries its SHA-512. We require it — without it we can't verify the
    // download, and running an unverified elevated installer is unacceptable.
    let yml_asset = assets
        .iter()
        .find(|a| a["name"].as_str().map(|n| n.eq_ignore_ascii_case("latest.yml")).unwrap_or(false))
        .ok_or("This release is missing latest.yml, so the download can't be verified — aborting for safety.")?;
    let yml = ureq::get(yml_asset["browser_download_url"].as_str().unwrap_or(""))
        .set("User-Agent", "Reliquary-Installer")
        .call()
        .map_err(|e| format!("Couldn't fetch release metadata: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let (path, sha512) = parse_latest_yml(&yml)
        .ok_or("Couldn't read the checksum from release metadata — aborting for safety.")?;

    // Select the exact installer named by latest.yml, not merely the first .exe.
    let asset = assets
        .iter()
        .find(|a| a["name"].as_str().map(|n| n.eq_ignore_ascii_case(&path)).unwrap_or(false))
        .ok_or("The release is missing the installer named by its metadata — aborting for safety.")?;

    Ok(ReleaseInfo {
        version,
        url: asset["browser_download_url"].as_str().unwrap_or("").to_string(),
        size: asset["size"].as_u64().unwrap_or(0),
        sha512,
    })
}

/// Stream-hash a file with SHA-512 and compare to the expected base64 digest
/// from `latest.yml`. Returns a user-facing error on any mismatch so the caller
/// can refuse to run the file.
fn verify_sha512(path: &std::path::Path, expected_b64: &str) -> Result<(), String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha512};

    let mut file = std::fs::File::open(path).map_err(|e| format!("Couldn't reopen download: {e}"))?;
    let mut hasher = Sha512::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("Couldn't read download: {e}"))?;
    let got = hasher.finalize();

    let want = base64::engine::general_purpose::STANDARD
        .decode(expected_b64.trim())
        .map_err(|_| "Release checksum was malformed — aborting for safety.".to_string())?;

    if got.as_slice() == want.as_slice() {
        Ok(())
    } else {
        Err("Security check failed: the downloaded installer did not match the \
             publisher's checksum and was NOT run. Your connection may be \
             compromised — try again on a network you trust."
            .into())
    }
}

/// Native folder picker (non-blocking).
#[tauri::command]
async fn pick_dir(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().map(|p| p.to_string())
}

/// Download the installer (emitting progress) then run it silently+elevated.
#[tauri::command]
fn install(app: AppHandle, url: String, dir: String, sha512: String) {
    std::thread::spawn(move || {
        let fail = |msg: String| {
            let _ = app.emit("failed", msg);
        };
        // Without a checksum we cannot verify the download — never run unverified.
        if sha512.trim().is_empty() {
            return fail("No checksum available for this release — aborting for safety.".into());
        }
        let _ = app.emit("status", json!({"message": "Downloading the latest Reliquary…"}));

        let resp = match ureq::get(&url).set("User-Agent", "Reliquary-Installer").call() {
            Ok(r) => r,
            Err(e) => return fail(format!("Download failed: {e}")),
        };
        let total: u64 = resp
            .header("Content-Length")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        // Download into a fresh per-run temp dir rather than a fixed, predictable
        // path in the shared %TEMP%, so another local process can't pre-plant or
        // swap the file between write and exec.
        let tmpdir = std::env::temp_dir().join(format!("reliquary-install-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmpdir);
        let tmp = tmpdir.join("ReliquarySetup.exe");
        let mut file = match std::fs::File::create(&tmp) {
            Ok(f) => f,
            Err(e) => return fail(format!("Couldn't write temp file: {e}")),
        };

        use std::io::{Read, Write};
        let mut reader = resp.into_reader();
        let mut buf = vec![0u8; 1 << 16];
        let mut got: u64 = 0;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(e) = file.write_all(&buf[..n]) {
                        return fail(format!("Disk write error: {e}"));
                    }
                    got += n as u64;
                    let percent = if total > 0 { (got * 100 / total) as u32 } else { 0 };
                    let _ = app.emit("progress", json!({"percent": percent, "got": got, "total": total}));
                }
                Err(e) => return fail(format!("Download error: {e}")),
            }
        }
        if let Err(e) = file.sync_all() {
            return fail(format!("Disk flush error: {e}"));
        }
        drop(file);

        // Verify the bytes match the publisher's checksum BEFORE running anything
        // elevated. On mismatch, delete the file and bail — never execute it.
        let _ = app.emit("status", json!({"message": "Verifying download…"}));
        if let Err(e) = verify_sha512(&tmp, &sha512) {
            let _ = std::fs::remove_file(&tmp);
            return fail(e);
        }

        let _ = app.emit("status", json!({"message": "Installing Reliquary…"}));
        match run_installer(&tmp, &dir) {
            Ok(0) => {
                let _ = app.emit("done", &dir);
            }
            Ok(code) => fail(format!("The installer exited with code {code}.")),
            Err(e) => fail(e),
        }
    });
}

/// Run the downloaded NSIS installer silently, into `dir`, elevated via UAC.
/// We build the parameter string by hand so NSIS sees `/D=<path>` unquoted
/// (NSIS requires the /D path to be the unquoted remainder of the line).
#[cfg(windows)]
fn run_installer(setup: &std::path::Path, dir: &str) -> Result<u32, String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file = HSTRING::from(setup.as_os_str());
    let params = HSTRING::from(format!("/S /D={dir}"));

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };

    unsafe {
        ShellExecuteExW(&mut info)
            .map_err(|_| "Installation was cancelled (admin permission declined).".to_string())?;
        if info.hProcess.is_invalid() {
            return Err("Could not start the installer process.".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code: u32 = 0;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        Ok(code)
    }
}

/// Open the freshly installed client.
#[tauri::command]
fn launch(dir: String) -> Result<(), String> {
    let exe = std::path::Path::new(&dir).join("Reliquary.exe");
    std::process::Command::new(exe)
        .spawn()
        .map_err(|e| format!("Couldn't launch Reliquary: {e}"))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_dir,
            fetch_latest,
            pick_dir,
            install,
            launch
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Reliquary installer");
}
