# Releasing Vault

Releases are built and uploaded by GitHub Actions. Pushing a version tag such
as `v0.2.0` runs `.github/workflows/release.yml`, which:

1. checks the tag matches `version` in `package.json`,
2. runs `npm run typecheck`,
3. builds the Windows installer and portable app,
4. publishes both files to a GitHub Release for that tag.

The release is published immediately (not left as a draft) because
`build.publish[0].releaseType` is `"release"`.

## Cutting a release

```powershell
# 1. Bump the version (this also updates package-lock.json)
npm version 0.2.0 --no-git-tag-version

# 2. Commit the version bump
git add package.json package-lock.json
git commit -m "Release v0.2.0"

# 3. Tag and push
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

Watch the run under the repository's **Actions** tab. When it finishes, the
release appears under **Releases** with:

- `Vault Setup <version>.exe` (NSIS installer)
- `Vault <version>.exe` (portable)

The filenames come from the app version, so they will carry the new version
number after a bump.

## Local publish (optional)

If you ever need to publish from this machine instead, create a GitHub token
with `repo` scope and run:

```powershell
$env:GH_TOKEN = "ghp_..."
npm run release
```

`npm run release` builds and uploads to the same GitHub Release.

## CI

`.github/workflows/ci.yml` runs `npm run typecheck` and `npm run smoke` on
pushes to `main` and on pull requests.
