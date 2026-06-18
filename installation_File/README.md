# Reliquary Installer

`ReliquarySetup.exe` is the distributable **client** installer. Hand this single file to
anyone — on launch it fetches the **latest** Reliquary release from GitHub
(`HPelto/Reliquary`), lets them choose an install folder (default
`C:\Program Files (x86)\ReliquaryApp`), shows progress, installs it, and can launch it.
You never need to rebuild it per version — it always pulls the newest release.

## Requirements for it to work
- At least one **published GitHub release** must exist (run `npm run release` in the repo
  root with a `GH_TOKEN` set). Until then the installer shows a "no release found yet" notice.
- Windows 10/11 with the **WebView2** runtime (present by default on Win11; the evergreen
  runtime is auto-installed on most Win10).

## Rebuilding the installer
From `installer/`, run **`build.cmd`** (needs Rust/cargo). It compiles the Tauri app and
copies the result here as `ReliquarySetup.exe`.

The `.exe` itself is git-ignored — distribute it via a GitHub release or directly.
