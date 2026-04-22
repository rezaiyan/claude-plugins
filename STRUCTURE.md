# claude-plugins — Repo Structure

## Overview

This repo (`rezaiyan/claude-plugins`) is a **Claude Code plugin marketplace**.
It holds the marketplace registry (`.claude-plugin/marketplace.json`) and links to individual plugin repos as **git submodules**.

Each plugin lives in its own GitHub repo and is referenced here by commit — not copied.

---

## Layout

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json        # Marketplace registry — lists all plugins + metadata
├── .gitmodules                 # Submodule declarations
├── README.md                   # Install instructions for end users
├── STRUCTURE.md                # This file
│
├── skillfetch/                 → git submodule: rezaiyan/skillfetch
├── claude-token-guard/         → git submodule: rezaiyan/claude-token-guard
└── claude-notifier/            → git submodule: rezaiyan/claude-notifier
```

---

## Submodules

| Folder | Repo | Purpose |
|--------|------|---------|
| `skillfetch/` | [rezaiyan/skillfetch](https://github.com/rezaiyan/skillfetch) | Sync AI skill instructions from GitHub repos |
| `claude-token-guard/` | [rezaiyan/claude-token-guard](https://github.com/rezaiyan/claude-token-guard) | Block expensive agents, rewrite verbose Bash |
| `claude-notifier/` | [rezaiyan/claude-notifier](https://github.com/rezaiyan/claude-notifier) | Desktop notifications on stop/wait events |

Each folder is a **read-only pointer** to a specific commit in its own repo.
Changes to plugins must be made in their own repos and then updated here.

---

## Working with Submodules

### Clone this repo (with plugins)

```sh
git clone --recurse-submodules git@github.com:rezaiyan/claude-plugins.git
```

### If already cloned without submodules

```sh
git submodule update --init --recursive
```

### Update a plugin to its latest commit

```sh
cd skillfetch && git pull origin main && cd ..
git add skillfetch
git commit -m "chore: bump skillfetch to latest"
```

### Add a new plugin repo as submodule

```sh
git submodule add git@github.com:rezaiyan/<plugin-name>.git <plugin-name>
# Then register it in .claude-plugin/marketplace.json
```

---

## marketplace.json

Defines what the Claude Code plugin system sees when a user runs:

```sh
claude plugin marketplace add rezaiyan/claude-plugins
```

Each entry maps a plugin `name` to its source GitHub repo.
The `source.repo` field must match the actual GitHub repo slug — not the local submodule path.