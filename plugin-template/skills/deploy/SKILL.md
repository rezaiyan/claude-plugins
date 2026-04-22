---
name: deploy
description: This skill should be used when the user wants to release, publish, bump the version, tag, or deploy this plugin.
version: 1.0.0
---

# Deploy — Plugin Release Workflow

Full release process: validate → bump version → commit → tag → push → GitHub release.

## Usage

```
/deploy patch      # 1.0.0 → 1.0.1
/deploy minor      # 1.0.0 → 1.1.0
/deploy major      # 1.0.0 → 2.0.0
/deploy v1.2.3     # explicit version
```

## Steps

### 1. Read current version

Read current version from `.claude-plugin/plugin.json` (the `"version"` field).
This is the sole authoritative version source.

### 2. Calculate new version

Apply the bump type, or use the explicit version provided.
If no argument given, ask: `"Bump type? [patch / minor / major / vX.Y.Z]"` and wait.

Show the version change before proceeding:
```
Current version : 1.0.0
New version     : 1.0.1
```

### 3. Validate plugin

```bash
claude plugin validate .
```

If validation fails → stop, show errors, do not proceed.

### 4. Confirm release plan

Show the full plan and ask `"Proceed with release? [Y/n]"` — wait for explicit `Y`.

```
Release plan for v1.0.1:
  • Bump version in .claude-plugin/plugin.json
  • Update CHANGELOG.md ([Unreleased] → [1.0.1] - YYYY-MM-DD)
  • git commit -m "chore: release v1.0.1"
  • git tag v1.0.1
  • git push origin main --tags
```

### 5. Run bump script

```bash
./scripts/bump-version.sh <bump-type>
```

The script updates `plugin.json`, `CHANGELOG.md`, commits, tags, and pushes.

### 6. Report

```
Released v1.0.1
  commit  abc1234
  tag     v1.0.1
  pushed  origin/main

Users update with:
  claude plugin update <name>@rezaiyan
```

## Error Handling

| Failure point | Action |
|--------------|--------|
| Validation fails (step 3) | Stop — show errors, nothing written |
| User says N at confirmation (step 4) | Stop — nothing done |
| `git push` fails | Report error — commit and tag exist locally, user can push manually |
