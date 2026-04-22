# Plugin Template — Setup Guide

Replace all `{{PLACEHOLDERS}}` before first commit.

## Placeholders

| Placeholder | Replace with |
|-------------|-------------|
| `{{PLUGIN_NAME}}` | e.g. `my-plugin` (must match GitHub repo name) |
| `{{DESCRIPTION}}` | One-line description |
| `{{YEAR}}` | Current year in `LICENSE` |
| `{{DATE}}` | Initial release date in `CHANGELOG.md` |

## Checklist

- [ ] Replace all placeholders (`grep -r "{{" .`)
- [ ] Fill in `README.md` — what it does, usage examples
- [ ] Fill in `.claude-plugin/plugin.json` keywords
- [ ] Add plugin entry to `rezaiyan/claude-plugins/.claude-plugin/marketplace.json`
- [ ] Run `claude plugin validate .` — fix any errors
- [ ] Add to `claude-plugins` as a git submodule

## Structure

```
{{PLUGIN_NAME}}/
├── .claude-plugin/
│   └── plugin.json              # Plugin metadata — name, version, description
├── .claude/
│   └── agents/
│       └── release.md           # Release agent — invoke to publish a new version
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── workflows/
│       └── release.yml          # Auto-creates GitHub release on tag push
├── scripts/
│   └── bump-version.sh          # Version bumper: patch/minor/major/x.y.z
├── skills/
│   └── deploy/
│       └── SKILL.md             # /deploy skill — guided release workflow
├── .gitignore
├── CHANGELOG.md                 # Keep a Changelog format — add to [Unreleased] before releasing
├── CONTRIBUTING.md
├── LICENSE                      # MIT
└── README.md
```

## Release workflow (once set up)

```bash
# 1. Add changes to CHANGELOG.md under [Unreleased]
# 2. Run the deploy skill or the script directly:
./scripts/bump-version.sh patch   # or: minor / major / 1.2.3
# That's it — commits, tags, pushes, GitHub release auto-created by CI
```
