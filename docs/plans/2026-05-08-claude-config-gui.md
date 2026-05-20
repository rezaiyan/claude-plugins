# Claude Config GUI — Implementation Plan

> **For agentic workers:** Use claude-kit:implement to execute this plan task-by-task.

**Goal:** Local web app at `localhost:3456` to view and toggle all Claude Code configuration (hooks, plugins, MCP servers, settings) without editing JSON manually.

**Architecture:** Bun HTTP server serves a vanilla JS single-page app. API routes read/write `~/.claude/settings.json` atomically (backup before every write). Hook disabling uses a `true # DISABLED: <cmd>` shell prefix — Claude Code runs `true` (noop) instead of the real hook. Fully reversible.

**Tech Stack:** Bun (runtime + HTTP server), TypeScript, vanilla HTML/JS/CSS (no framework, no build step).

---

## Config Audit (what the app controls)

### Hooks in settings.json

| Event | Matcher | File | Source |
|-------|---------|------|--------|
| SessionStart | * | session-start.js | claude-kit/memory |
| UserPromptSubmit | * | user-prompt-submit.js | claude-kit/memory |
| PostToolUse | `.*` | context_monitor.py | local |
| PostToolUse | `.*` | post-tool-use.js | claude-kit/memory |
| PostToolUse | `Write\|Edit\|…` | file_checker.py | local |
| PostToolUse | `Write\|Edit\|…` | post-edit-format.js | claude-kit/quality |
| PostToolUse | `Write\|Edit\|…` | check-console-log.js | claude-kit/quality |
| PreToolUse | `Bash` | bash_trimmer.py | local |
| PreToolUse | `Bash` | block-no-verify.js | claude-kit/quality |
| PreToolUse | `Agent` | agent_guard.py | local |
| PreToolUse | `Write\|Edit` | config-protection.js | claude-kit/quality |
| Stop | * | share_suggester.py | local |
| Stop | * | stop.js | claude-kit/memory |
| Stop | * | desktop-notify.js | claude-kit/quality |
| SessionEnd | * | session-end.js | claude-kit/memory |

### Plugins (`enabledPlugins`)
frontend-design, clangd-lsp, atlassian, claude-code-setup, claude-token-guard, context-mode, codex, caveman, skillfetch

### MCP Servers
context7, brave-search, web-fetch

### Misc Settings
model (sonnet), skipDangerousModePermissionPrompt (true), statusLine (npx ccusage@latest statusline)

---

## File Map

```
~/projects/claude-config-gui/
├── package.json
├── server.ts                  # Bun HTTP server + all API routes
├── lib/
│   ├── types.ts               # Shared interfaces
│   ├── config.ts              # Read/write settings.json (atomic)
│   ├── hooks.ts               # Hook parse + toggle logic
│   ├── hooks.test.ts
│   ├── plugins.ts             # Plugin parse + toggle logic
│   ├── plugins.test.ts
│   ├── mcp.ts                 # MCP server parse + toggle logic
│   └── mcp.test.ts
├── public/
│   ├── index.html             # Single-page shell
│   ├── style.css              # Dark theme
│   └── app.js                 # All UI logic (vanilla JS)
└── README.md
```

---

## Done: 0 / Left: 10

---

### Task 1: Project Scaffold

**Files:**
- Create: `~/projects/claude-config-gui/package.json`
- Create: `~/projects/claude-config-gui/lib/.gitkeep`
- Create: `~/projects/claude-config-gui/public/.gitkeep`

- [ ] **Step 1: Create project directory**

```bash
mkdir -p ~/projects/claude-config-gui/lib ~/projects/claude-config-gui/public
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "claude-config-gui",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "bun run server.ts",
    "test": "bun test"
  },
  "devDependencies": {}
}
```

- [ ] **Step 3: Verify bun is available**

```bash
bun --version
```
Expected: `1.x.x`

- [ ] **Step 4: Commit**

```bash
cd ~/projects/claude-config-gui && git init && git add package.json && git commit -m "chore: init claude-config-gui project"
```

---

### Task 2: Types

**Files:**
- Create: `~/projects/claude-config-gui/lib/types.ts`

No tests — interfaces only.

- [ ] **Step 1: Write types.ts**

```typescript
// lib/types.ts

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
  timeout?: number;
}

export type HooksMap = Record<string, HookEntry[]>;

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface ClaudeConfig {
  hooks?: HooksMap;
  mcpServers?: Record<string, McpServerConfig>;
  _disabledMcpServers?: Record<string, McpServerConfig>;
  enabledPlugins?: Record<string, boolean>;
  model?: string;
  skipDangerousModePermissionPrompt?: boolean;
  statusLine?: string | { type: string; command: string };
  extraKnownMarketplaces?: Record<string, unknown>;
  [key: string]: unknown;
}

// Normalized shapes returned by the API
export interface ParsedHook {
  id: string;          // sha1(event::matcher::rawCommand).slice(0,12)
  event: string;
  matcher: string;
  command: string;     // always the raw command (no DISABLED prefix)
  displayName: string;
  description: string;
  source: "claude-kit" | "local" | "plugin";
  disabled: boolean;
}

export interface ParsedPlugin {
  id: string;          // "name@marketplace"
  name: string;
  marketplace: string;
  enabled: boolean;
}

export interface ParsedMcpServer {
  name: string;
  purpose: string;
  enabled: boolean;
  config: McpServerConfig;
}

export interface ParsedRule {
  filename: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ConfigResponse {
  hooks: ParsedHook[];
  plugins: ParsedPlugin[];
  mcp: ParsedMcpServer[];
  settings: {
    model: string;
    skipDangerousModePermissionPrompt: boolean;
    statusLine: string;
  };
  rules: ParsedRule[];
  lastBackup: string | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/types.ts && git commit -m "feat: add shared types"
```

---

### Task 3: lib/hooks.ts (TDD)

**Files:**
- Create: `~/projects/claude-config-gui/lib/hooks.ts`
- Create: `~/projects/claude-config-gui/lib/hooks.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/hooks.test.ts
import { describe, test, expect } from "bun:test";
import {
  isDisabled,
  rawCommand,
  disableCommand,
  enableCommand,
  parseHooks,
  toggleHook,
  hookId,
} from "./hooks.ts";
import type { ClaudeConfig } from "./types.ts";

const SAMPLE_CONFIG: ClaudeConfig = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "bun /projects/claude-kit/hooks/memory/session-start.js" }] },
    ],
    PostToolUse: [
      {
        matcher: ".*",
        hooks: [
          { type: "command", command: "python3 ~/.claude/hooks/context_monitor.py" },
          { type: "command", command: "bun /projects/claude-kit/hooks/memory/post-tool-use.js" },
        ],
      },
      {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "bun /projects/claude-kit/hooks/quality/post-edit-format.js" }],
      },
    ],
  },
};

describe("isDisabled", () => {
  test("returns false for normal command", () => {
    expect(isDisabled("bun ./hook.js")).toBe(false);
  });
  test("returns true for disabled command", () => {
    expect(isDisabled("true # DISABLED: bun ./hook.js")).toBe(true);
  });
});

describe("rawCommand", () => {
  test("returns command unchanged if not disabled", () => {
    expect(rawCommand("bun ./hook.js")).toBe("bun ./hook.js");
  });
  test("strips DISABLED prefix", () => {
    expect(rawCommand("true # DISABLED: bun ./hook.js")).toBe("bun ./hook.js");
  });
});

describe("disableCommand / enableCommand", () => {
  test("disableCommand wraps with prefix", () => {
    expect(disableCommand("bun ./hook.js")).toBe("true # DISABLED: bun ./hook.js");
  });
  test("disableCommand is idempotent", () => {
    const once = disableCommand("bun ./hook.js");
    expect(disableCommand(once)).toBe(once);
  });
  test("enableCommand strips prefix", () => {
    expect(enableCommand("true # DISABLED: bun ./hook.js")).toBe("bun ./hook.js");
  });
  test("enableCommand is idempotent on non-disabled", () => {
    expect(enableCommand("bun ./hook.js")).toBe("bun ./hook.js");
  });
});

describe("parseHooks", () => {
  test("returns one ParsedHook per command", () => {
    const hooks = parseHooks(SAMPLE_CONFIG);
    expect(hooks).toHaveLength(4);
  });
  test("hook has correct event", () => {
    const hooks = parseHooks(SAMPLE_CONFIG);
    expect(hooks[0].event).toBe("SessionStart");
    expect(hooks[1].event).toBe("PostToolUse");
  });
  test("hook has correct matcher", () => {
    const hooks = parseHooks(SAMPLE_CONFIG);
    expect(hooks[0].matcher).toBe("*");
    expect(hooks[1].matcher).toBe(".*");
    expect(hooks[3].matcher).toBe("Write|Edit");
  });
  test("disabled hook has disabled=true and raw command", () => {
    const cfg: ClaudeConfig = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "true # DISABLED: python3 ~/.claude/hooks/share_suggester.py" }] },
        ],
      },
    };
    const hooks = parseHooks(cfg);
    expect(hooks[0].disabled).toBe(true);
    expect(hooks[0].command).toBe("python3 ~/.claude/hooks/share_suggester.py");
  });
  test("enabled hook has disabled=false", () => {
    const hooks = parseHooks(SAMPLE_CONFIG);
    expect(hooks.every(h => !h.disabled)).toBe(true);
  });
  test("hook has stable id", () => {
    const hooks = parseHooks(SAMPLE_CONFIG);
    const id = hookId("SessionStart", "*", "bun /projects/claude-kit/hooks/memory/session-start.js");
    expect(hooks[0].id).toBe(id);
  });
});

describe("toggleHook", () => {
  test("disables an enabled hook", () => {
    const hooks = parseHooks(SAMPLE_CONFIG);
    const target = hooks[0]; // SessionStart hook
    const updated = toggleHook(SAMPLE_CONFIG, target.id);
    const updatedHooks = parseHooks(updated);
    expect(updatedHooks[0].disabled).toBe(true);
    // raw command preserved
    expect(updatedHooks[0].command).toBe(target.command);
  });
  test("enables a disabled hook", () => {
    const cfg: ClaudeConfig = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "true # DISABLED: python3 ~/.claude/hooks/share_suggester.py" }] },
        ],
      },
    };
    const hooks = parseHooks(cfg);
    const updated = toggleHook(cfg, hooks[0].id);
    expect(parseHooks(updated)[0].disabled).toBe(false);
  });
  test("does not mutate original config", () => {
    const hooks = parseHooks(SAMPLE_CONFIG);
    toggleHook(SAMPLE_CONFIG, hooks[0].id);
    expect(parseHooks(SAMPLE_CONFIG)[0].disabled).toBe(false);
  });
  test("returns config unchanged if id not found", () => {
    const updated = toggleHook(SAMPLE_CONFIG, "nonexistent");
    expect(updated).toEqual(SAMPLE_CONFIG);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd ~/projects/claude-config-gui && bun test lib/hooks.test.ts
```
Expected: FAIL — "Cannot find module './hooks.ts'"

- [ ] **Step 3: Write hooks.ts**

```typescript
// lib/hooks.ts
import { createHash } from "crypto";
import type { ClaudeConfig, ParsedHook } from "./types.ts";

const DISABLED_PREFIX = "true # DISABLED: ";

const HOOK_META: Record<string, { displayName: string; description: string; source: ParsedHook["source"] }> = {
  "session-start.js":    { displayName: "Session Memory Restore",  description: "Injects last 5 session summaries as context on start",         source: "claude-kit" },
  "user-prompt-submit.js": { displayName: "Session Init + Compact Restore", description: "Idempotent session init; restores compact-state after compaction", source: "claude-kit" },
  "context_monitor.py":  { displayName: "Context Monitor",         description: "Warns at 65%/75% usage; auto-saves state snapshot at 75%",      source: "local" },
  "post-tool-use.js":    { displayName: "Observation Logger",      description: "Saves tool observations to SQLite for session memory",           source: "claude-kit" },
  "file_checker.py":     { displayName: "File Checker",            description: "Validates files after Write/Edit operations",                    source: "local" },
  "post-edit-format.js": { displayName: "Auto Formatter",          description: "Auto-formats files after edits",                                source: "claude-kit" },
  "check-console-log.js":{ displayName: "Console.log Guard",       description: "Warns when console.log remains in production code",             source: "claude-kit" },
  "bash_trimmer.py":     { displayName: "Bash Output Trimmer",     description: "Trims large Bash output to protect context window",              source: "local" },
  "block-no-verify.js":  { displayName: "Block --no-verify",       description: "Blocks git --no-verify and --no-gpg-sign flags",                source: "claude-kit" },
  "agent_guard.py":      { displayName: "Agent Guard",             description: "Blocks forbidden agent patterns (Explore/Research descriptions)", source: "local" },
  "config-protection.js":{ displayName: "Config Protection",       description: "Protects sensitive config files from accidental edits",          source: "claude-kit" },
  "share_suggester.py":  { displayName: "Share Suggester",         description: "Suggests sharing the session transcript on stop",                source: "local" },
  "stop.js":             { displayName: "Session Summarizer",      description: "Parses transcript and writes structured summary to SQLite",      source: "claude-kit" },
  "desktop-notify.js":   { displayName: "Desktop Notifier",        description: "Shows macOS desktop notification when Claude stops",             source: "claude-kit" },
  "session-end.js":      { displayName: "Session Cleanup",         description: "Runs session cleanup tasks on end",                              source: "claude-kit" },
};

export function hookId(event: string, matcher: string, rawCmd: string): string {
  return createHash("sha1").update(`${event}::${matcher}::${rawCmd}`).digest("hex").slice(0, 12);
}

export function isDisabled(command: string): boolean {
  return command.startsWith(DISABLED_PREFIX);
}

export function rawCommand(command: string): string {
  return isDisabled(command) ? command.slice(DISABLED_PREFIX.length) : command;
}

export function disableCommand(command: string): string {
  return isDisabled(command) ? command : `${DISABLED_PREFIX}${command}`;
}

export function enableCommand(command: string): string {
  return rawCommand(command);
}

function getMeta(cmd: string): { displayName: string; description: string; source: ParsedHook["source"] } {
  const filename = cmd.split("/").at(-1) ?? cmd;
  return HOOK_META[filename] ?? { displayName: filename, description: "Hook script", source: "local" };
}

export function parseHooks(config: ClaudeConfig): ParsedHook[] {
  const result: ParsedHook[] = [];
  for (const [event, entries] of Object.entries(config.hooks ?? {})) {
    for (const entry of entries) {
      const matcher = entry.matcher ?? "*";
      for (const hookCmd of entry.hooks) {
        const raw = rawCommand(hookCmd.command);
        const meta = getMeta(raw);
        result.push({
          id: hookId(event, matcher, raw),
          event,
          matcher,
          command: raw,
          displayName: meta.displayName,
          description: meta.description,
          source: meta.source,
          disabled: isDisabled(hookCmd.command),
        });
      }
    }
  }
  return result;
}

export function toggleHook(config: ClaudeConfig, targetId: string): ClaudeConfig {
  const updated = structuredClone(config);
  for (const [event, entries] of Object.entries(updated.hooks ?? {})) {
    for (const entry of entries) {
      const matcher = entry.matcher ?? "*";
      for (const hookCmd of entry.hooks) {
        const raw = rawCommand(hookCmd.command);
        if (hookId(event, matcher, raw) === targetId) {
          hookCmd.command = isDisabled(hookCmd.command)
            ? enableCommand(hookCmd.command)
            : disableCommand(hookCmd.command);
          return updated;
        }
      }
    }
  }
  return updated;
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
bun test lib/hooks.test.ts
```
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add lib/hooks.ts lib/hooks.test.ts && git commit -m "feat: add hooks parse/toggle logic with tests"
```

---

### Task 4: lib/plugins.ts (TDD)

**Files:**
- Create: `~/projects/claude-config-gui/lib/plugins.ts`
- Create: `~/projects/claude-config-gui/lib/plugins.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/plugins.test.ts
import { describe, test, expect } from "bun:test";
import { parsePlugins, togglePlugin } from "./plugins.ts";
import type { ClaudeConfig } from "./types.ts";

const SAMPLE_CONFIG: ClaudeConfig = {
  enabledPlugins: {
    "frontend-design@claude-plugins-official": true,
    "caveman@caveman": true,
    "context-mode@context-mode": false,
  },
};

describe("parsePlugins", () => {
  test("returns one entry per plugin", () => {
    expect(parsePlugins(SAMPLE_CONFIG)).toHaveLength(3);
  });
  test("splits id into name and marketplace", () => {
    const plugins = parsePlugins(SAMPLE_CONFIG);
    const cave = plugins.find(p => p.id === "caveman@caveman")!;
    expect(cave.name).toBe("caveman");
    expect(cave.marketplace).toBe("caveman");
  });
  test("enabled=true when value is true", () => {
    const plugins = parsePlugins(SAMPLE_CONFIG);
    expect(plugins.find(p => p.id === "frontend-design@claude-plugins-official")!.enabled).toBe(true);
  });
  test("enabled=false when value is false", () => {
    const plugins = parsePlugins(SAMPLE_CONFIG);
    expect(plugins.find(p => p.id === "context-mode@context-mode")!.enabled).toBe(false);
  });
  test("returns empty array if no enabledPlugins", () => {
    expect(parsePlugins({})).toEqual([]);
  });
});

describe("togglePlugin", () => {
  test("disables an enabled plugin", () => {
    const updated = togglePlugin(SAMPLE_CONFIG, "caveman@caveman");
    expect(updated.enabledPlugins!["caveman@caveman"]).toBe(false);
  });
  test("enables a disabled plugin", () => {
    const updated = togglePlugin(SAMPLE_CONFIG, "context-mode@context-mode");
    expect(updated.enabledPlugins!["context-mode@context-mode"]).toBe(true);
  });
  test("does not mutate original config", () => {
    togglePlugin(SAMPLE_CONFIG, "caveman@caveman");
    expect(SAMPLE_CONFIG.enabledPlugins!["caveman@caveman"]).toBe(true);
  });
  test("no-ops if plugin id not found", () => {
    const updated = togglePlugin(SAMPLE_CONFIG, "nonexistent@nowhere");
    expect(updated.enabledPlugins).toEqual(SAMPLE_CONFIG.enabledPlugins);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test lib/plugins.test.ts
```
Expected: FAIL — "Cannot find module './plugins.ts'"

- [ ] **Step 3: Write plugins.ts**

```typescript
// lib/plugins.ts
import type { ClaudeConfig, ParsedPlugin } from "./types.ts";

export function parsePlugins(config: ClaudeConfig): ParsedPlugin[] {
  return Object.entries(config.enabledPlugins ?? {}).map(([id, enabled]) => {
    const atIndex = id.indexOf("@");
    const name = atIndex === -1 ? id : id.slice(0, atIndex);
    const marketplace = atIndex === -1 ? "unknown" : id.slice(atIndex + 1);
    return { id, name, marketplace, enabled: enabled === true };
  });
}

export function togglePlugin(config: ClaudeConfig, pluginId: string): ClaudeConfig {
  if (!config.enabledPlugins || !(pluginId in config.enabledPlugins)) return config;
  const updated = structuredClone(config);
  updated.enabledPlugins![pluginId] = !updated.enabledPlugins![pluginId];
  return updated;
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
bun test lib/plugins.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/plugins.ts lib/plugins.test.ts && git commit -m "feat: add plugins parse/toggle logic with tests"
```

---

### Task 5: lib/mcp.ts (TDD)

**Files:**
- Create: `~/projects/claude-config-gui/lib/mcp.ts`
- Create: `~/projects/claude-config-gui/lib/mcp.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// lib/mcp.test.ts
import { describe, test, expect } from "bun:test";
import { parseMcp, toggleMcp } from "./mcp.ts";
import type { ClaudeConfig } from "./types.ts";

const SAMPLE_CONFIG: ClaudeConfig = {
  mcpServers: {
    "context7": { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] },
    "brave-search": { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"] },
  },
  _disabledMcpServers: {
    "web-fetch": { command: "npx", args: ["-y", "mcp-remote"] },
  },
};

describe("parseMcp", () => {
  test("returns all servers (active + disabled)", () => {
    expect(parseMcp(SAMPLE_CONFIG)).toHaveLength(3);
  });
  test("active servers have enabled=true", () => {
    const servers = parseMcp(SAMPLE_CONFIG);
    expect(servers.find(s => s.name === "context7")!.enabled).toBe(true);
    expect(servers.find(s => s.name === "brave-search")!.enabled).toBe(true);
  });
  test("disabled servers have enabled=false", () => {
    const servers = parseMcp(SAMPLE_CONFIG);
    expect(servers.find(s => s.name === "web-fetch")!.enabled).toBe(false);
  });
  test("assigns known purpose for context7", () => {
    const servers = parseMcp(SAMPLE_CONFIG);
    expect(servers.find(s => s.name === "context7")!.purpose).toContain("documentation");
  });
  test("sorts by name", () => {
    const names = parseMcp(SAMPLE_CONFIG).map(s => s.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("toggleMcp", () => {
  test("disables an active server (moves to _disabledMcpServers)", () => {
    const updated = toggleMcp(SAMPLE_CONFIG, "context7");
    expect(updated.mcpServers!["context7"]).toBeUndefined();
    expect(updated._disabledMcpServers!["context7"]).toBeDefined();
  });
  test("enables a disabled server (moves to mcpServers)", () => {
    const updated = toggleMcp(SAMPLE_CONFIG, "web-fetch");
    expect(updated.mcpServers!["web-fetch"]).toBeDefined();
    expect(updated._disabledMcpServers!["web-fetch"]).toBeUndefined();
  });
  test("does not mutate original config", () => {
    toggleMcp(SAMPLE_CONFIG, "context7");
    expect(SAMPLE_CONFIG.mcpServers!["context7"]).toBeDefined();
  });
  test("no-ops if server name not found", () => {
    const updated = toggleMcp(SAMPLE_CONFIG, "nonexistent");
    expect(updated.mcpServers).toEqual(SAMPLE_CONFIG.mcpServers);
    expect(updated._disabledMcpServers).toEqual(SAMPLE_CONFIG._disabledMcpServers);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test lib/mcp.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write mcp.ts**

```typescript
// lib/mcp.ts
import type { ClaudeConfig, ParsedMcpServer } from "./types.ts";

const MCP_PURPOSES: Record<string, string> = {
  "context7":    "Library & framework documentation lookup",
  "brave-search": "Web search via Brave Search API",
  "web-fetch":   "Fetch full web pages (JS-rendered)",
};

export function parseMcp(config: ClaudeConfig): ParsedMcpServer[] {
  const active = Object.entries(config.mcpServers ?? {}).map(([name, cfg]) => ({
    name,
    purpose: MCP_PURPOSES[name] ?? "MCP server",
    enabled: true,
    config: cfg,
  }));
  const disabled = Object.entries(config._disabledMcpServers ?? {}).map(([name, cfg]) => ({
    name,
    purpose: MCP_PURPOSES[name] ?? "MCP server",
    enabled: false,
    config: cfg,
  }));
  return [...active, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
}

export function toggleMcp(config: ClaudeConfig, serverName: string): ClaudeConfig {
  const updated = structuredClone(config);
  if (!updated.mcpServers) updated.mcpServers = {};
  if (!updated._disabledMcpServers) updated._disabledMcpServers = {};

  if (updated.mcpServers[serverName]) {
    updated._disabledMcpServers[serverName] = updated.mcpServers[serverName];
    delete updated.mcpServers[serverName];
  } else if (updated._disabledMcpServers[serverName]) {
    updated.mcpServers[serverName] = updated._disabledMcpServers[serverName];
    delete updated._disabledMcpServers[serverName];
  }
  return updated;
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
bun test lib/mcp.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/mcp.ts lib/mcp.test.ts && git commit -m "feat: add MCP server parse/toggle logic with tests"
```

---

### Task 6: lib/config.ts

**Files:**
- Create: `~/projects/claude-config-gui/lib/config.ts`

No unit tests — wraps real FS. Verified by server integration.

- [ ] **Step 1: Write config.ts**

```typescript
// lib/config.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import type { ClaudeConfig } from "./types.ts";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const BACKUP_DIR = join(homedir(), ".claude", "backups");

export function readConfig(): ClaudeConfig {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  return JSON.parse(raw);
}

export function writeConfig(config: ClaudeConfig): void {
  // Always backup before writing
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(BACKUP_DIR, `settings-${ts}.json`), JSON.stringify(config, null, 2));

  // Atomic write via tmp file
  const tmp = join(tmpdir(), `claude-settings-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, SETTINGS_PATH);
}

export function getLastBackup(): string | null {
  if (!existsSync(BACKUP_DIR)) return null;
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("settings-") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (!files[0]) return null;
  // "settings-2026-05-08T12-00-00-000Z.json" → "2026-05-08T12:00:00.000Z"
  return files[0]
    .replace("settings-", "")
    .replace(".json", "")
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/config.ts && git commit -m "feat: add atomic settings.json read/write with backup"
```

---

### Task 7: server.ts

**Files:**
- Create: `~/projects/claude-config-gui/server.ts`

- [ ] **Step 1: Write server.ts**

```typescript
// server.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readConfig, writeConfig, getLastBackup } from "./lib/config.ts";
import { parseHooks, toggleHook } from "./lib/hooks.ts";
import { parsePlugins, togglePlugin } from "./lib/plugins.ts";
import { parseMcp, toggleMcp } from "./lib/mcp.ts";
import type { ClaudeConfig, ConfigResponse } from "./lib/types.ts";

const PORT = 3456;
const PUBLIC_DIR = join(import.meta.dir, "public");
const RULES_DIR = join(homedir(), ".claude", "rules");

function parseRules() {
  try {
    return readdirSync(RULES_DIR).map(filename => {
      const path = join(RULES_DIR, filename);
      const stat = statSync(path);
      return { filename, path, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    });
  } catch {
    return [];
  }
}

function parseSettings(config: ClaudeConfig) {
  const sl = config.statusLine;
  const statusLine = typeof sl === "string" ? sl : (sl as any)?.command ?? "";
  return {
    model: (config.model as string) ?? "sonnet",
    skipDangerousModePermissionPrompt: config.skipDangerousModePermissionPrompt === true,
    statusLine,
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function staticFile(filename: string, contentType: string) {
  try {
    return new Response(readFileSync(join(PUBLIC_DIR, filename)), {
      headers: { "Content-Type": contentType },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname: path, } = url;
    const method = req.method;

    // ── API ──────────────────────────────────────────────────
    if (path === "/api/config" && method === "GET") {
      const config = readConfig();
      const response: ConfigResponse = {
        hooks: parseHooks(config),
        plugins: parsePlugins(config),
        mcp: parseMcp(config),
        settings: parseSettings(config),
        rules: parseRules(),
        lastBackup: getLastBackup(),
      };
      return json(response);
    }

    if (path === "/api/hooks/toggle" && method === "POST") {
      const { id } = await req.json() as { id: string };
      const updated = toggleHook(readConfig(), id);
      writeConfig(updated);
      return json({ ok: true });
    }

    if (path === "/api/plugins/toggle" && method === "POST") {
      const { id } = await req.json() as { id: string };
      const updated = togglePlugin(readConfig(), id);
      writeConfig(updated);
      return json({ ok: true });
    }

    if (path === "/api/mcp/toggle" && method === "POST") {
      const { name } = await req.json() as { name: string };
      const updated = toggleMcp(readConfig(), name);
      writeConfig(updated);
      return json({ ok: true });
    }

    if (path === "/api/settings" && method === "PUT") {
      const body = await req.json() as Partial<{ model: string; skipDangerousModePermissionPrompt: boolean; statusLine: string }>;
      const config = readConfig();
      if (body.model !== undefined) config.model = body.model;
      if (body.skipDangerousModePermissionPrompt !== undefined) {
        config.skipDangerousModePermissionPrompt = body.skipDangerousModePermissionPrompt;
      }
      if (body.statusLine !== undefined) config.statusLine = body.statusLine;
      writeConfig(config);
      return json({ ok: true });
    }

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    // ── Static ───────────────────────────────────────────────
    if (path === "/" || path === "/index.html") return staticFile("index.html", "text/html");
    if (path === "/app.js")    return staticFile("app.js",    "application/javascript");
    if (path === "/style.css") return staticFile("style.css", "text/css");

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n  Claude Config GUI  →  http://localhost:${PORT}\n`);
```

- [ ] **Step 2: Verify server starts**

```bash
cd ~/projects/claude-config-gui && bun run server.ts &
sleep 1 && curl -s http://localhost:3456/api/config | python3 -m json.tool | head -30
kill %1
```
Expected: JSON response with hooks, plugins, mcp, settings arrays

- [ ] **Step 3: Commit**

```bash
git add server.ts && git commit -m "feat: add Bun HTTP server with all API routes"
```

---

### Task 8: public/style.css

**Files:**
- Create: `~/projects/claude-config-gui/public/style.css`

- [ ] **Step 1: Write style.css**

```css
/* public/style.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #0f1117;
  --surface:  #1a1d27;
  --border:   #2a2d3a;
  --text:     #e2e8f0;
  --muted:    #64748b;
  --accent:   #6366f1;
  --green:    #22c55e;
  --red:      #ef4444;
  --yellow:   #f59e0b;
  --radius:   8px;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
}

/* ── Header ── */
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}

header h1 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
}

#status-bar {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--muted);
}

#status-bar span { display: flex; align-items: center; gap: 4px; }
#status-bar .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }

/* ── Nav ── */
nav {
  display: flex;
  gap: 2px;
  padding: 8px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.nav-btn {
  background: none;
  border: none;
  color: var(--muted);
  padding: 6px 14px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: color 0.15s, background 0.15s;
}

.nav-btn:hover { color: var(--text); background: var(--border); }
.nav-btn.active { color: var(--text); background: var(--border); }

/* ── Main ── */
main { padding: 24px; max-width: 900px; }

.tab { display: none; }
.tab.active { display: block; }

/* ── Section headings ── */
.section-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 24px 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.section-header:first-child { margin-top: 0; }

/* ── Hook row ── */
.hook-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  margin-bottom: 6px;
  transition: opacity 0.2s;
}

.hook-row.disabled { opacity: 0.45; }

.hook-info { flex: 1; min-width: 0; }

.hook-name {
  font-weight: 500;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hook-desc {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hook-meta { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }

.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 99px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.badge-ck  { background: #312e81; color: #a5b4fc; }
.badge-loc { background: #1c3a27; color: #86efac; }
.badge-plt { background: #3b1f2b; color: #f9a8d4; }

.matcher {
  font-size: 10px;
  font-family: monospace;
  color: var(--muted);
  background: var(--border);
  padding: 1px 6px;
  border-radius: 4px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Plugin grid ── */
.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.plugin-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: opacity 0.2s;
}

.plugin-card.disabled { opacity: 0.45; }

.plugin-name { font-weight: 600; font-size: 13px; }
.plugin-market { font-size: 11px; color: var(--muted); font-family: monospace; }

/* ── MCP list ── */
.mcp-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 6px;
  transition: opacity 0.2s;
}

.mcp-row.disabled { opacity: 0.45; }
.mcp-name { font-weight: 600; font-size: 13px; }
.mcp-purpose { font-size: 12px; color: var(--muted); }

/* ── Rules list ── */
.rule-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 6px;
}

.rule-name { font-weight: 500; font-family: monospace; font-size: 12px; }
.rule-meta { font-size: 11px; color: var(--muted); }

/* ── Settings panel ── */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 8px;
}

.setting-label { font-weight: 500; }
.setting-desc  { font-size: 12px; color: var(--muted); margin-top: 2px; }

select, input[type="text"] {
  background: var(--border);
  border: 1px solid #3a3d4a;
  color: var(--text);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}

select:focus, input[type="text"]:focus { border-color: var(--accent); }

input[type="text"] { width: 320px; }

/* ── Toggle switch ── */
.toggle {
  position: relative;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

.toggle input { opacity: 0; width: 0; height: 0; }

.toggle-track {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 99px;
  cursor: pointer;
  transition: background 0.2s;
}

.toggle input:checked + .toggle-track { background: var(--accent); }

.toggle-track::after {
  content: "";
  position: absolute;
  width: 14px;
  height: 14px;
  left: 3px;
  top: 3px;
  background: white;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle input:checked + .toggle-track::after { transform: translateX(16px); }

/* ── Save indicator ── */
#save-indicator {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: var(--green);
  color: #000;
  padding: 8px 16px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 600;
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
}

#save-indicator.show { opacity: 1; }
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css && git commit -m "feat: add dark theme CSS"
```

---

### Task 9: public/index.html

**Files:**
- Create: `~/projects/claude-config-gui/public/index.html`

- [ ] **Step 1: Write index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Config</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>

<header>
  <h1>Claude Config</h1>
  <div id="status-bar">
    <span id="stat-model"></span>
    <span id="stat-hooks"></span>
    <span id="stat-plugins"></span>
    <span id="stat-mcp"></span>
    <span id="stat-backup"></span>
  </div>
</header>

<nav>
  <button class="nav-btn active" data-tab="hooks">Hooks</button>
  <button class="nav-btn" data-tab="plugins">Plugins</button>
  <button class="nav-btn" data-tab="mcp">MCP Servers</button>
  <button class="nav-btn" data-tab="rules">Rules</button>
  <button class="nav-btn" data-tab="settings">Settings</button>
</nav>

<main>
  <section id="tab-hooks"    class="tab active"></section>
  <section id="tab-plugins"  class="tab"></section>
  <section id="tab-mcp"      class="tab"></section>
  <section id="tab-rules"    class="tab"></section>
  <section id="tab-settings" class="tab"></section>
</main>

<div id="save-indicator">Saved</div>

<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html && git commit -m "feat: add single-page HTML shell"
```

---

### Task 10: public/app.js (Full UI)

**Files:**
- Create: `~/projects/claude-config-gui/public/app.js`

- [ ] **Step 1: Write app.js**

```javascript
// public/app.js
"use strict";

// ── State ──────────────────────────────────────────────────
let state = null;

// ── Utilities ─────────────────────────────────────────────
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }

function toggle(label) {
  const id = `toggle-${label}`;
  return `<label class="toggle" aria-label="Toggle">
    <input type="checkbox" id="${id}">
    <span class="toggle-track"></span>
  </label>`;
}

function badge(source) {
  const cls = source === "claude-kit" ? "badge-ck" : source === "plugin" ? "badge-plt" : "badge-loc";
  const text = source === "claude-kit" ? "claude-kit" : source === "plugin" ? "plugin" : "local";
  return `<span class="badge ${cls}">${text}</span>`;
}

function showSaved() {
  const el = $("#save-indicator");
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1500);
}

async function api(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

// ── Status Bar ────────────────────────────────────────────
function renderStatusBar(data) {
  const activeHooks  = data.hooks.filter(h => !h.disabled).length;
  const totalHooks   = data.hooks.length;
  const activePlugins = data.plugins.filter(p => p.enabled).length;
  const totalPlugins  = data.plugins.length;
  const activeMcp    = data.mcp.filter(s => s.enabled).length;
  const totalMcp     = data.mcp.length;

  $("#stat-model").innerHTML   = `<span class="dot"></span>${data.settings.model}`;
  $("#stat-hooks").textContent  = `${activeHooks}/${totalHooks} hooks`;
  $("#stat-plugins").textContent = `${activePlugins}/${totalPlugins} plugins`;
  $("#stat-mcp").textContent    = `${activeMcp}/${totalMcp} MCP`;
  $("#stat-backup").textContent = data.lastBackup
    ? `backup ${new Date(data.lastBackup).toLocaleTimeString()}`
    : "no backup";
}

// ── Hooks Panel ───────────────────────────────────────────
function renderHooks(hooks) {
  const events = [...new Set(hooks.map(h => h.event))];
  const section = $("#tab-hooks");

  section.innerHTML = events.map(event => {
    const group = hooks.filter(h => h.event === event);
    const rows = group.map(h => `
      <div class="hook-row ${h.disabled ? "disabled" : ""}" data-hook-id="${h.id}">
        <div class="hook-info">
          <div class="hook-name">${h.displayName}</div>
          <div class="hook-desc">${h.description}</div>
        </div>
        <div class="hook-meta">
          <span class="matcher" title="${h.matcher}">${h.matcher}</span>
          ${badge(h.source)}
          ${toggle(h.id)}
        </div>
      </div>
    `).join("");
    return `<div class="section-header">${event}</div>${rows}`;
  }).join("");

  // Wire toggles
  hooks.forEach(h => {
    const input = $(`#toggle-${h.id}`);
    if (!input) return;
    input.checked = !h.disabled;
    input.addEventListener("change", async () => {
      await api("/api/hooks/toggle", "POST", { id: h.id });
      showSaved();
      await refresh();
    });
  });
}

// ── Plugins Panel ─────────────────────────────────────────
function renderPlugins(plugins) {
  const section = $("#tab-plugins");
  section.innerHTML = `
    <div class="section-header">Installed Plugins</div>
    <div class="plugin-grid">
      ${plugins.map(p => `
        <div class="plugin-card ${p.enabled ? "" : "disabled"}" data-plugin-id="${p.id}">
          <div>
            <div class="plugin-name">${p.name}</div>
            <div class="plugin-market">${p.marketplace}</div>
          </div>
          ${toggle(p.id)}
        </div>
      `).join("")}
    </div>
  `;

  plugins.forEach(p => {
    const input = $(`#toggle-${p.id}`);
    if (!input) return;
    input.checked = p.enabled;
    input.addEventListener("change", async () => {
      await api("/api/plugins/toggle", "POST", { id: p.id });
      showSaved();
      await refresh();
    });
  });
}

// ── MCP Panel ─────────────────────────────────────────────
function renderMcp(servers) {
  const section = $("#tab-mcp");
  section.innerHTML = `
    <div class="section-header">MCP Servers</div>
    ${servers.map(s => `
      <div class="mcp-row ${s.enabled ? "" : "disabled"}" data-mcp-name="${s.name}">
        <div style="flex:1">
          <div class="mcp-name">${s.name}</div>
          <div class="mcp-purpose">${s.purpose}</div>
        </div>
        ${toggle(`mcp-${s.name}`)}
      </div>
    `).join("")}
  `;

  servers.forEach(s => {
    const input = $(`#toggle-mcp-${s.name}`);
    if (!input) return;
    input.checked = s.enabled;
    input.addEventListener("change", async () => {
      await api("/api/mcp/toggle", "POST", { name: s.name });
      showSaved();
      await refresh();
    });
  });
}

// ── Rules Panel ───────────────────────────────────────────
function renderRules(rules) {
  const section = $("#tab-rules");
  section.innerHTML = `
    <div class="section-header">Rule Files (read-only)</div>
    ${rules.map(r => `
      <div class="rule-row">
        <span class="rule-name">${r.filename}</span>
        <span class="rule-meta">${(r.sizeBytes / 1024).toFixed(1)} KB · ${new Date(r.modifiedAt).toLocaleDateString()}</span>
      </div>
    `).join("")}
  `;
}

// ── Settings Panel ────────────────────────────────────────
function renderSettings(settings) {
  const section = $("#tab-settings");
  section.innerHTML = `
    <div class="section-header">Model</div>
    <div class="setting-row">
      <div>
        <div class="setting-label">Active Model</div>
        <div class="setting-desc">Model used in all Claude Code sessions</div>
      </div>
      <select id="setting-model">
        <option value="sonnet" ${settings.model === "sonnet" ? "selected" : ""}>claude-sonnet (default)</option>
        <option value="opus"   ${settings.model === "opus"   ? "selected" : ""}>claude-opus</option>
        <option value="haiku"  ${settings.model === "haiku"  ? "selected" : ""}>claude-haiku</option>
      </select>
    </div>

    <div class="section-header">Behavior</div>
    <div class="setting-row">
      <div>
        <div class="setting-label">Skip Dangerous Mode Permission Prompt</div>
        <div class="setting-desc">Suppress the permission prompt in dangerous mode</div>
      </div>
      ${toggle("skip-dangerous")}
    </div>

    <div class="section-header">Status Line</div>
    <div class="setting-row">
      <div>
        <div class="setting-label">Status Line Command</div>
        <div class="setting-desc">Shell command for the Claude Code status bar</div>
      </div>
      <input type="text" id="setting-statusline" value="${settings.statusLine}">
    </div>
    <button id="save-settings" style="margin-top:12px; padding:8px 20px; background:var(--accent); color:#fff; border:none; border-radius:var(--radius); cursor:pointer; font-size:13px; font-weight:600;">
      Save Settings
    </button>
  `;

  const skipInput = $(`#toggle-skip-dangerous`);
  if (skipInput) skipInput.checked = settings.skipDangerousModePermissionPrompt;

  $("#save-settings").addEventListener("click", async () => {
    const model    = $("#setting-model").value;
    const skipDangerous = $(`#toggle-skip-dangerous`)?.checked ?? false;
    const statusLine    = $("#setting-statusline").value;
    await api("/api/settings", "PUT", { model, skipDangerousModePermissionPrompt: skipDangerous, statusLine });
    showSaved();
    await refresh();
  });
}

// ── Tab Navigation ────────────────────────────────────────
function initNav() {
  $$(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".nav-btn").forEach(b => b.classList.remove("active"));
      $$(".tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      $(`#tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// ── Main ──────────────────────────────────────────────────
async function refresh() {
  const data = await api("/api/config");
  state = data;
  renderStatusBar(data);
  renderHooks(data.hooks);
  renderPlugins(data.plugins);
  renderMcp(data.mcp);
  renderRules(data.rules);
  renderSettings(data.settings);
}

initNav();
refresh();
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js && git commit -m "feat: add full vanilla JS UI (hooks, plugins, MCP, rules, settings)"
```

---

### Task 11: Verify in Browser

- [ ] **Step 1: Start server**

```bash
cd ~/projects/claude-config-gui && bun run server.ts
```
Expected: `Claude Config GUI  →  http://localhost:3456`

- [ ] **Step 2: Open in browser and verify each panel**

Open `http://localhost:3456` and verify:
- Hooks panel shows all 15 hooks grouped by event (SessionStart, UserPromptSubmit, PostToolUse, PreToolUse, Stop, SessionEnd)
- Toggle a hook → row dims → toggling back restores it
- Plugins panel shows 9 plugin cards in a grid
- Toggle a plugin → card dims → toggling back restores it
- MCP panel shows 3 servers (brave-search, context7, web-fetch)
- Rules panel shows 9 rule files with sizes and dates
- Settings panel shows model dropdown (sonnet selected), skip-dangerous toggle (on), status line input
- Status bar shows model + counts
- "Saved" toast appears after every toggle

- [ ] **Step 3: Verify settings.json was modified**

```bash
cat ~/.claude/settings.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('model:', d.get('model')); print('hooks keys:', list(d.get('hooks',{}).keys()))"
```
Expected: shows current model and all hook event names

- [ ] **Step 4: Verify backup was created**

```bash
ls -la ~/.claude/backups/ | tail -5
```
Expected: timestamped `settings-*.json` files

- [ ] **Step 5: Run full test suite**

```bash
cd ~/projects/claude-config-gui && bun test
```
Expected: All tests PASS (hooks, plugins, mcp)

- [ ] **Step 6: Commit**

```bash
git add . && git commit -m "feat: complete Claude Config GUI — hooks, plugins, MCP, rules, settings"
```

---

## Done: 0 / Left: 10

---

## Spec Coverage

| Requirement | Task |
|-------------|------|
| View all hooks grouped by event | T10 (renderHooks) |
| Toggle hooks on/off | T3 (hooks.ts toggleHook) + T10 |
| View all plugins | T10 (renderPlugins) |
| Toggle plugins on/off | T4 (plugins.ts togglePlugin) + T10 |
| View MCP servers | T10 (renderMcp) |
| Toggle MCP servers on/off | T5 (mcp.ts toggleMcp) + T10 |
| View rules files | T10 (renderRules) |
| Change model | T10 (renderSettings) |
| Toggle skipDangerousModePermissionPrompt | T10 |
| Edit status line | T10 |
| Atomic settings.json writes | T6 (config.ts) |
| Backup before every write | T6 |
| No mutation of disabled hooks | T3 (DISABLED prefix strategy) |
| No mutation of disabled MCP | T5 (_disabledMcpServers key) |
| Status bar with live counts | T10 (renderStatusBar) |

No gaps.
