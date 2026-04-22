# {{PLUGIN_NAME}}

{{DESCRIPTION}}

---

## What it does

<!-- Describe what the plugin does -->

---

## Install

### Claude Code plugin (recommended)

```bash
# Add the marketplace (once)
claude plugin marketplace add rezaiyan/claude-plugins

# Install
claude plugin install {{PLUGIN_NAME}}@rezaiyan
```

### Manual

```bash
git clone https://github.com/rezaiyan/{{PLUGIN_NAME}}
cd {{PLUGIN_NAME}}
./install.sh
```

---

## Usage

<!-- Describe commands or behaviour -->

---

## Uninstall

```bash
claude plugin uninstall {{PLUGIN_NAME}}@rezaiyan
```

---

## Requirements

- Claude Code with plugin support
- Python 3.8+

---

## License

MIT

---

## More Claude tools by rezaiyan

| Plugin | Description | Install |
|--------|-------------|---------|
| [claude-notifier](https://github.com/rezaiyan/claude-notifier) | Desktop notifications when Claude finishes or needs input (macOS + Linux) | `claude plugin install claude-notifier@rezaiyan` |
| [claude-token-guard](https://github.com/rezaiyan/claude-token-guard) | Cut token burn — blocks expensive agents, rewrites verbose Bash commands | `claude plugin install claude-token-guard@rezaiyan` |
| [skillfetch](https://github.com/rezaiyan/skillfetch) | Sync AI skill instructions from GitHub repos — security-scanned, diff-previewed | `claude plugin install skillfetch@rezaiyan` |
