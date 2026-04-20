# rezaiyan/claude-plugins

Claude Code plugin marketplace by Ali Rezaiyan.

## Add marketplace

```shell
claude plugin marketplace add rezaiyan/claude-plugins
```

## Plugins

| Plugin | Description | Install |
|--------|-------------|---------|
| [skillfetch](https://github.com/rezaiyan/skillfetch) | Safely pull AI skill instructions from GitHub repos — security-scanned, diff-previewed, local annotations survive updates | `claude plugin install skillfetch@rezaiyan` |
| [claude-token-guard](https://github.com/rezaiyan/claude-token-guard) | Cut token burn — blocks expensive Explore/Plan agents, rewrites verbose Bash commands before they run | `claude plugin install claude-token-guard@rezaiyan` |
| [claude-notifier](https://github.com/rezaiyan/claude-notifier) | Desktop notifications when Claude finishes or needs input (macOS + Linux) | `claude plugin install claude-notifier@rezaiyan` |

## Quick start

```shell
# 1. Add this marketplace (once)
claude plugin marketplace add rezaiyan/claude-plugins

# 2. Install any plugin
claude plugin install skillfetch@rezaiyan
claude plugin install claude-token-guard@rezaiyan
claude plugin install claude-notifier@rezaiyan
```
