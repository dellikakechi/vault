# Vault

A local-first media library for images, comics, GIFs and video.

Everything stays on your machine: Vault indexes folders you add, generates
thumbnails, and stores tags in a local database. No account, no cloud.

## Download and install (Windows)

1. Open **[the latest release](https://github.com/dellikakechi/vault/releases/latest)**.
2. Download **`Vault-Setup-<version>.exe`** from the **Assets** list at the
   bottom of the release notes.
3. Run the file and follow the installer. You can choose the install folder;
   it creates a Start Menu shortcut.

That is the whole process. The other files in Assets are optional:

| Asset | Purpose |
| --- | --- |
| `Vault-Setup-<version>.exe` | **Recommended.** Installs Vault for the current user. |
| `Vault-Portable-<version>.exe` | Runs Vault without installing anything. |
| `latest.yml`, `*.blockmap` | Auto-update metadata. You do not need these. |

Windows SmartScreen may warn that the app is unrecognized because the builds
are not code-signed yet. Choose **More info → Run anyway**.

## Features

- Folders of images, GIFs, video, and comic archives in one library
- Tags with categories, search, and bulk editing
- Duplicate detection with review and keep/delete choices
- Image sets and custom video thumbnails
- Comic reader and full-screen image viewer
- AI-assisted tagging through a local or remote model of your choice

## Development

```powershell
npm install
npm run dev        # run the app with hot reload
npm run typecheck  # type-check main, preload, and renderer
npm run smoke      # build and run the automated UI smoke test
npm run dist       # build the Windows installer and portable app
```

Releases are produced by GitHub Actions. See [RELEASING.md](RELEASING.md) for
the version-bump and tag workflow.
