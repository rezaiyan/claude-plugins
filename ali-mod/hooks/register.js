// ali-mod: one band above the prompt for daily work.
//   ops       ctx %, git branch, prod health, model/effort buttons, /health and /vps
//   clean     /clean hides tool rows and shows the plan as a checklist
//   sessions  every session writes a heartbeat file; /sessions lists live ones (Mac + Pi)
//   cache     warns before a message re-reads a chat whose prompt cache went cold
//   handoff   at high context, /handoff saves a note the next chat in this folder starts from
//   share     /screenshare masks emails, keys, IPs, amounts and chosen words on screen
//   agents    one row per running subagent: model, steps, last tool, tokens, time
// Claude Code allows one hooks module per plugin and one hook per event, so all parts live here.

const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "max"];
const HEALTH_EVERY_MS = 10 * 60_000;
const GIT_EVERY_MS = 15_000;

const TOOL_SITES = /^Tool(Use|Result|Group|Progress)$/;
const PLAN_ROWS = 8;
const PLAN_ORDER = { in_progress: 0, pending: 1, completed: 2 };

const BEAT_EVERY_MS = 10_000;
const LIVE_MS = 45_000; // a heartbeat older than this means the session is gone
const STALE_MS = 24 * 60 * 60_000; // a heartbeat older than this gets deleted
const PI_EVERY_MS = 30_000;
const PI_HOST = "pi5.local";
const PANE = "ali-sessions";

// Claude Code subscriptions write the prompt cache with a one-hour lifetime
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_SOON_MS = 10 * 60_000; // the band starts counting down this long before
const COLD_CONFIRM_MS = 60_000; // a second Enter within this sends anyway
const HANDOFF_AT = 75; // context percent at which the band suggests /handoff
const HANDOFF_PROMPT =
  "Write a handoff note so a fresh chat can continue this work with no other context. " +
  "Markdown, under 400 words, sections: Goal, Done so far, Current state (files, branches, " +
  "commands that matter), Decisions and why, Open problems, Next steps. Facts only, no preamble.";

// ── ops state ──
let git = null; // { branch, dirty } or null outside a repo
let prod = null; // 'up' | 'down' | null (not checked yet)
let model = null; // short name of the session's model
let effort = null; // effort the last request used
let effortOverride = null; // set when /effort could not be run for us

// ── clean state ──
let clean = false;
let tasks = []; // { id, subject, status, startedAt?, endedAt? }
let promptTitle = null; // the prompt the plan works on
let turnStartedAt = null;
let hidden = 0; // tool calls hidden this turn
let lastTool = null;

// ── sessions state ──
let dir = null; // ~/.claude/ali-mod/sessions
let me = null; // { id, host }
let working = false;
let local = []; // live sessions on this machine
let remote = []; // live sessions on the Pi
let paneOpen = false;

// ── cache, handoff, share, agents state ──
let lastReplyAt = null; // $.clock time the last turn ended: when the cache was last written
let lastTokens = 0; // context tokens the next message re-reads
let coldConfirmUntil = 0;
let share = false;
let redactWords = []; // extra words /screenshare add masks
let agents = []; // { id, toolUseId, description, model, startedAt, endedAt?, steps, tokens, lastTool }

const redraw = ($) => $.ui.invalidate("ui.render");
// Background refreshes: a failure only leaves the band a little stale
const quiet = (p) => p.catch(() => {});
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const shortModel = (id) => MODELS.find((m) => id.includes(m)) ?? id;
const isLive = (s) => !s.ended && Date.now() - s.at < LIVE_MS;
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
const fmtTokens = (n) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 100_000 ? 0 : 1) + "k" : String(n);
const isCold = (now) =>
  lastReplyAt !== null && now - lastReplyAt >= CACHE_TTL_MS;
const handoffPath = (cwd) =>
  dir.replace(/sessions$/, "handoff") +
  "/" +
  cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") +
  ".md";
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ── ops ──

async function runAli($, args) {
  const ali = (await $.env.get("HOME")) + "/bin/ali";
  const r = await $.process.run([ali, ...args]);
  return stripAnsi((r.stdout || "") + (r.stderr || "")).trim();
}

async function refreshHealth($) {
  const out = await runAli($, ["health"]);
  prod = out.includes("All services healthy") ? "up" : "down";
  redraw($);
  return out;
}

async function refreshGit($) {
  const branch = await $.process.run(["git", "branch", "--show-current"]);
  if (branch.exitCode !== 0) {
    git = null;
  } else {
    const status = await $.process.run(["git", "status", "--porcelain"]);
    git = {
      branch: branch.stdout.trim() || "detached",
      dirty: status.stdout.trim() !== "",
    };
  }
  model = shortModel(await $.session.model());
  redraw($);
}

// Same as picking it in /model: changes the session and the saved default
async function setModel($, name) {
  await $.config.set({ key: "model", value: name });
  model = name;
  await loadEffort($);
  redraw($);
}

// The saved effort for the session's model (modelSettings), else the global one,
// until the first request reports the effort actually in use
async function loadEffort($) {
  const s = /** @type {any} */ (await $.settings.read().catch(() => ({})));
  const id = await $.session.model();
  const perModel = Object.entries(s.modelSettings ?? {}).find(([key]) =>
    id.startsWith(key),
  );
  const saved = perModel?.[1]?.effortLevel ?? s.effortLevel;
  effort = typeof saved === "string" ? saved : null;
}

async function setEffort($, level) {
  try {
    await $.command.run({ command: "effort", args: level });
    effortOverride = null;
  } catch {
    // Fallback: rewrite the effort on each request of this session
    effortOverride = level;
  }
  effort = level;
  redraw($);
}

// ── clean ──

async function toggleClean($) {
  clean = !clean;
  await $.store.set("clean", clean);
  redraw($);
}

// Moves a task to a status and stamps when its work started and ended
function setStatus(task, status) {
  const now = Date.now();
  if (status === "in_progress" && !task.startedAt) task.startedAt = now;
  if (status === "completed" && !task.endedAt) {
    task.startedAt ??= now;
    task.endedAt = now;
  }
  task.status = status;
  return task;
}

// TaskCreate answers with text naming the new id, as in "Task #3 created"
function idFrom(result, fallback) {
  const m = JSON.stringify(result ?? "").match(/#(\d+)/);
  return m ? m[1] : fallback;
}

// ── sessions ──

async function beat($, extra = {}) {
  const usage = await $.session.usage();
  const info = {
    id: me.id,
    host: me.host,
    cwd: await $.session.cwd(),
    branch: git?.branch ?? null,
    model: await $.session.model(),
    pct: Math.round(usage?.context?.percent ?? 0),
    working,
    at: Date.now(),
    ...extra,
  };
  await $.fs.write(dir + "/" + me.id + ".json", JSON.stringify(info) + "\n");
}

async function readLocal($) {
  const entries = await $.fs.list(dir).catch(() => []);
  const all = await Promise.all(
    entries
      .filter((f) => f.name.endsWith(".json"))
      .map(async (f) =>
        parseJson(await $.fs.read(dir + "/" + f.name).catch(() => "")),
      ),
  );
  local = all.filter((s) => s && isLive(s));
  redraw($);

  // Heartbeats of sessions gone for a day are only clutter
  const stale = all
    .filter((s) => s && Date.now() - s.at > STALE_MS)
    .map((s) => dir + "/" + s.id + ".json");
  if (stale.length) await $.process.run(["rm", "-f", ...stale]);
}

async function readPi($) {
  const r = await $.process.run(
    [
      "ssh",
      "-o",
      "ConnectTimeout=3",
      "-o",
      "BatchMode=yes",
      PI_HOST,
      "cat ~/.claude/ali-mod/sessions/*.json 2>/dev/null",
    ],
    { timeoutMs: 8000 },
  );
  remote = (r.stdout || "")
    .split("\n")
    .map(parseJson)
    .filter((s) => s && isLive(s));
  redraw($);
}

/** @param {import('claude-code').On} on */
export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "health",
      description: "ali health: check prod services (no tokens)",
    });
    await $.command.register({
      name: "vps",
      description: "ali status: VPS containers (no tokens)",
    });
    await $.command.register({
      name: "clean",
      description: "Toggle clean view: hide tool rows, show plan checklist",
    });
    await $.command.register({
      name: "sessions",
      description: "Session bar: live Claude sessions on Mac and Pi",
    });
    await $.command.register({
      name: "handoff",
      description:
        "Save a handoff note; the next chat in this folder starts from it",
    });
    await $.command.register({
      name: "screenshare",
      description: "Mask private details on screen (add <word> | clear)",
    });

    clean = (await $.store.get("clean")) === true;
    const words = await $.store.get("redact");
    redactWords = Array.isArray(words) ? words : [];
    await loadEffort($);
    dir = (await $.env.get("HOME")) + "/.claude/ali-mod/sessions";
    const host = await $.process.run(["hostname", "-s"]);
    me = { id: await $.session.id(), host: host.stdout.trim() || "mac" };

    // Fire and forget, so session start is not blocked by git, network or disk
    refreshGit($)
      .then(() => beat($))
      .then(() => readLocal($))
      .catch(() => {});
    quiet(refreshHealth($));
    $.clock.every(GIT_EVERY_MS, () => refreshGit($));
    $.clock.every(HEALTH_EVERY_MS, () => refreshHealth($));
    $.clock.every(BEAT_EVERY_MS, async () => {
      await beat($);
      await readLocal($);
    });
    $.clock.every(PI_EVERY_MS, async () => {
      if (paneOpen) await readPi($);
    });
    // The plan's clock and activity cells move each second while Claude works
    $.clock.every(1000, () => {
      if ((clean && working && tasks.length) || agents.some((a) => !a.endedAt))
        redraw($);
    });
    // The cache countdown in the band moves by the minute
    $.clock.every(30_000, () => {
      if (lastReplyAt !== null) redraw($);
    });
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    if (me) await beat($, { ended: true });
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (!e.text || e.text.startsWith("/") || e.command || e.isMeta)
      return next(e);
    // Hold the first send to a cold chat: it re-reads the whole context at full price
    const now = await $.clock.now();
    if (isCold(now) && now > coldConfirmUntil) {
      coldConfirmUntil = now + COLD_CONFIRM_MS;
      await $.prompt.fill({ text: e.text, mode: "replace" });
      $.ui.toast(
        "Cache cold: this message re-reads " +
          fmtTokens(lastTokens) +
          " tokens at full price. Enter again to send, or /handoff first.",
      );
      return { drop: "prompt cache cold" };
    }
    promptTitle = e.text.replace(/\s+/g, " ").trim();
    return next(e);
  }).catch(($, e, next) => next(e));

  on("turn.start", async ($, e, next) => {
    hidden = 0;
    turnStartedAt = Date.now();
    working = true;
    agents = agents.filter((a) => !a.endedAt);
    quiet(beat($));
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    // A subagent's turn ending says nothing about the main chat or its cache
    if (e.agentId) return next(e);
    working = false;
    lastReplyAt = await $.clock.now();
    coldConfirmUntil = 0;
    const usage = await $.session.usage().catch(() => null);
    lastTokens = usage?.context?.tokens ?? lastTokens;
    quiet(beat($));
    quiet(refreshGit($));
    return next(e);
  });

  // A streaming event: the hook is a generator that forwards the response
  on("turn.step", async function* ($, e, next) {
    if (e.agentId) {
      const response = yield* next(e);
      const a = agents.find((x) => x.id === e.agentId);
      const u = response?.usage;
      if (a && u) {
        a.tokens +=
          u.input_tokens + u.cache_creation_input_tokens + u.output_tokens;
        a.model = shortModel(u.model);
      }
      return response;
    }
    if (typeof e.effort === "string" && e.effort !== effort && !effortOverride)
      effort = e.effort;
    const sent =
      effortOverride && e.effort !== undefined
        ? { ...e, effort: effortOverride }
        : e;
    const response = yield* next(sent);
    // The context grew with this request, so the ctx bar is stale now
    redraw($);
    return response;
  });

  on("tool.call", async ($, e, next) => {
    if (e.agentId) {
      const a = agents.find((x) => x.id === e.agentId);
      if (a) {
        a.steps += 1;
        a.lastTool = e.tool;
        redraw($);
      }
      return next(e);
    }
    hidden += 1;
    lastTool = e.tool;
    // The tool's input fields sit on the event itself, beside `tool`
    const input = /** @type {any} */ (e);

    if (e.tool === "TodoWrite" && Array.isArray(input.todos)) {
      // TodoWrite resends the whole list: keep each task's timings by its text
      const before = new Map(tasks.map((t) => [t.subject, t]));
      tasks = input.todos.map((t, i) =>
        setStatus(
          { ...before.get(t.content), id: String(i + 1), subject: t.content },
          t.status,
        ),
      );
    }
    const result = await next(e);
    if (e.tool === "Agent" || e.tool === "Task") {
      for (const a of agents)
        if (a.toolUseId === e.tool_use_id && !a.endedAt) a.endedAt = Date.now();
    }
    if (e.tool === "TaskCreate") {
      tasks.push({
        id: idFrom(result, String(tasks.length + 1)),
        subject: input.subject,
        status: "pending",
      });
    }
    if (e.tool === "TaskUpdate") {
      const t = tasks.find((x) => x.id === String(input.taskId));
      if (t && input.status === "deleted") tasks = tasks.filter((x) => x !== t);
      else if (t) {
        if (input.subject) t.subject = input.subject;
        if (input.status) setStatus(t, input.status);
      }
    }
    redraw($);
    return result;
    // A bug in the tracking above must never block the tool
  }).catch(($, e, next) => next(e));

  on("command.run", { command: "health" }, async ($) => ({
    text: await refreshHealth($),
  }));

  on("command.run", { command: "vps" }, async ($) => ({
    text: await runAli($, ["status"]),
  }));

  on("command.run", { command: "clean" }, async ($) => {
    await toggleClean($);
    return { text: "Clean view " + (clean ? "on" : "off") };
  });

  on("command.run", { command: "sessions" }, async ($) => {
    paneOpen = true;
    await readLocal($);
    $.ui.open({
      id: PANE,
      title: "Sessions",
      focus: true,
      closeOnEscape: true,
    });
    quiet(readPi($));
    return {};
  });

  on("command.run", { command: "handoff" }, async ($) => {
    $.ui.toast("Writing handoff…");
    const r = await $.model.fork({ prompt: HANDOFF_PROMPT });
    if (!r.isAnswered) return { text: "Handoff not written: " + r.reason };
    const path = handoffPath(await $.session.cwd());
    await $.process.run(["mkdir", "-p", path.replace(/\/[^/]+$/, "")]);
    await $.fs.write(path, r.text.trim() + "\n");
    return {
      text:
        "Handoff saved → " +
        path +
        "\nRun /clear (or start a new session here): its first message starts from it.",
    };
  });

  // The first message of a fresh chat in this folder carries the waiting handoff, once
  on("prompt.context", async ($, e, next) => {
    const r = await next(e);
    const path = handoffPath(await $.session.cwd());
    const note = await $.fs.read(path).catch(() => null);
    if (!note) return r;
    await $.process.run(["mv", path, path.replace(/\.md$/, ".used.md")]);
    return {
      ...r,
      blocks: [
        ...r.blocks,
        {
          name: "handoff",
          text:
            "Handoff from the previous chat in this folder. Continue from it.\n\n" +
            note,
        },
      ],
    };
  }).catch(($, e, next) => next(e));

  on("command.run", { command: "screenshare" }, async ($, e) => {
    const [verb, ...rest] = (e.args ?? "").trim().split(/\s+/);
    const word = rest.join(" ");
    if (verb === "add" && word) {
      redactWords = [...new Set([...redactWords, word])];
      await $.store.set("redact", redactWords);
      redraw($);
      return { text: "Masking " + redactWords.length + " custom word(s)" };
    }
    if (verb === "clear") {
      redactWords = [];
      await $.store.set("redact", redactWords);
      redraw($);
      return { text: "Custom masked words cleared" };
    }
    share = !share;
    redraw($);
    return { text: "Screen-share mode " + (share ? "on" : "off") };
  });

  // Screen-share mode rewrites only what is drawn: the transcript keeps the real text
  on(
    "ui.render",
    { component: /^(UserMessage|AssistantMessage)$/ },
    async ($, e, next) =>
      share
        ? next({ ...e, props: { ...e.props, text: redact(e.props.text) } })
        : next(e),
  );

  on("agent.spawn", async ($, e, next) => {
    const r = await next(e);
    if (r?.agentId) {
      agents.push({
        id: r.agentId,
        toolUseId: e.tool_use_id,
        description: e.description,
        model: shortModel(r.model ?? ""),
        startedAt: Date.now(),
        steps: 0,
        tokens: 0,
        lastTool: null,
      });
      redraw($);
    }
    return r;
  }).catch(($, e, next) => next(e));

  on("ui.close", async ($, e, next) => {
    if (e.id === PANE) paneOpen = false;
    return next(e);
  }).catch(($, e, next) => next(e));

  // An empty Box draws nothing, so the tool row disappears
  on("ui.render", { component: TOOL_SITES }, async ($, e, next) => {
    if (clean) return $.ui.resolve(e).Box({ children: [] });
    if (!share) return next(e);
    const props = /** @type {any} */ (e.props);
    return next({
      ...e,
      props: {
        ...props,
        ...("input" in props ? { input: redactDeep(props.input) } : {}),
        ...("output" in props ? { output: redactDeep(props.output) } : {}),
      },
    });
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const el = $.ui.resolve(e);
    const { Box, Text, Button } = el;
    const all = [...local, ...remote].sort(
      (a, b) => Number(b.working) - Number(a.working) || b.at - a.at,
    );
    if (!all.length) {
      return Box({
        paddingX: 1,
        children: [
          Text({
            color: "subtle",
            children: ["No live sessions — start one with claude"],
          }),
        ],
      });
    }

    const busy = all.filter((s) => s.working).length;
    const header = Box({
      key: "header",
      flexDirection: "row",
      columnGap: 1,
      marginBottom: 1,
      children: [
        Text({ bold: true, children: [all.length + " live"] }),
        Text({ color: "subtle", children: ["·"] }),
        Text({
          color: busy ? "warning" : "subtle",
          children: [busy ? busy + " working" : "all idle"],
        }),
      ],
    });

    const columns = e.props.bodyColumns ?? 80;
    const nameWidth = Math.max(12, Math.min(22, Math.floor(columns * 0.25)));
    const cell = (key, width, child) =>
      Box({ key, width, flexShrink: 0, children: [child] });

    const rows = all.map((s) => {
      const mine = s.id === me?.id;
      const onPi = s.host !== me?.host;
      const resume =
        (onPi ? "ssh " + PI_HOST + " -t " : "") +
        "cd " +
        s.cwd +
        " && claude --resume " +
        s.id;
      return Box({
        key: s.id,
        flexDirection: "row",
        columnGap: 2,
        children: [
          Box({
            key: "name",
            width: nameWidth + 2,
            flexShrink: 0,
            flexDirection: "row",
            children: [
              Text({
                color: s.working ? "warning" : "success",
                children: [s.working ? "● " : "○ "],
              }),
              Text({
                bold: mine,
                wrap: "truncate-end",
                children: [base(s.cwd)],
              }),
            ],
          }),
          cell(
            "status",
            7,
            Text({
              color: s.working ? "warning" : "subtle",
              children: [s.working ? "working" : "idle"],
            }),
          ),
          cell(
            "branch",
            16,
            Text({
              color: "suggestion",
              wrap: "truncate-end",
              children: [s.branch ? "⎇ " + s.branch : ""],
            }),
          ),
          cell(
            "model",
            6,
            Text({ color: "subtle", children: [shortModel(s.model)] }),
          ),
          ctxBar(el, s.pct, 6),
          Text({
            key: "host",
            color: onPi ? "planMode" : "subtle",
            children: [s.host],
          }),
          mine
            ? Text({ key: "this", color: "claude", children: ["this session"] })
            : Button({
                key: "copy",
                label: "copy resume",
                plain: true,
                dimColor: true,
                onPress: async () => {
                  await $.ui.copy({ text: resume });
                  $.ui.toast("Copied: " + resume);
                },
              }),
        ],
      });
    });

    return Box({
      flexDirection: "column",
      paddingX: 1,
      children: [header, ...rows],
    });
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const el = $.ui.resolve(e);
    const { Box, Text, Button } = el;
    const usage = await $.session.usage();
    const pct = Math.round(usage?.context?.percent ?? 0);
    const busy = local.filter((s) => s.working).length;
    // Beside an open pane the band is narrow: shorter labels, smaller bar
    const narrow = (e.props.bodyColumns ?? 120) < 100;
    // Pieces that must stay on one line together; a row wraps between groups
    const group = (key, children, gap = 1) =>
      Box({
        key,
        flexDirection: "row",
        flexShrink: 0,
        columnGap: gap,
        children,
      });

    // Row 1: what the session and prod look like right now
    const status = [];
    if (!narrow)
      status.push(
        group("brand", [
          Text({ color: "claude", children: ["✻"] }),
          Text({ bold: true, children: ["ali"] }),
        ]),
      );
    status.push(
      group("ctx", [label(el, "ctx"), ctxBar(el, pct, narrow ? 6 : 12)]),
    );
    if (git) {
      const branch =
        narrow && git.branch.length > 14
          ? git.branch.slice(0, 13) + "…"
          : git.branch;
      status.push(
        group(
          "git",
          [
            Text({ color: "suggestion", children: ["⎇ " + branch] }),
            ...(git.dirty ? [Text({ color: "warning", children: ["*"] })] : []),
          ],
          0,
        ),
      );
    }
    if (prod) {
      const up = prod === "up";
      status.push(
        group("prod", [
          Text({ color: up ? "success" : "error", children: ["●"] }),
          Text({ color: up ? "subtle" : "error", children: ["prod"] }),
          ...(up ? [] : [Text({ color: "subtle", children: ["/health"] })]),
        ]),
      );
    }
    status.push(
      group("sessions", [
        Text({ color: "planMode", children: ["◆"] }),
        Text({
          color: "subtle",
          children: [local.length + (narrow ? "" : " sessions")],
        }),
        ...(busy
          ? [Text({ color: "warning", children: ["· " + busy + " busy"] })]
          : []),
      ]),
    );
    if (lastReplyAt !== null && !e.props.isWorking) {
      const left = CACHE_TTL_MS - ((await $.clock.now()) - lastReplyAt);
      if (left <= 0)
        status.push(
          group("cache", [
            Text({ color: "warning", children: ["◌"] }),
            Text({ color: "warning", children: ["cache cold"] }),
          ]),
        );
      else if (left <= CACHE_SOON_MS)
        status.push(
          group("cache", [
            Text({ color: "subtle", children: ["◷"] }),
            Text({
              color: "subtle",
              children: ["cache " + Math.ceil(left / 60_000) + "m"],
            }),
          ]),
        );
    }
    if (pct >= HANDOFF_AT)
      status.push(
        group("handoff", [
          Text({ color: levelColor(pct), children: ["↻ /handoff"] }),
        ]),
      );
    if (share)
      status.push(
        group("share", [
          Text({ color: "error", children: ["●"] }),
          Text({ color: "error", children: ["sharing"] }),
        ]),
      );

    // Row 2: radio-style toggles, the active one at full strength
    const choice = (key, text, active, onPress) =>
      Button({
        key,
        label: (active ? "◉ " : "○ ") + text,
        plain: true,
        dimColor: !active,
        onPress,
      });
    const short = { medium: "med" };
    const controls = [
      group("models", [
        ...(narrow ? [] : [label(el, "model")]),
        ...MODELS.map((m) =>
          choice("model-" + m, m, m === model, () => setModel($, m)),
        ),
      ]),
      group("efforts", [
        ...(narrow ? [] : [label(el, "effort")]),
        ...EFFORTS.map((l) =>
          choice(
            "effort-" + l,
            narrow ? (short[l] ?? l) : l,
            l === effort,
            () => setEffort($, l),
          ),
        ),
      ]),
      group("clean", [choice("clean", "clean", clean, () => toggleClean($))]),
    ];

    const row = (key, children) =>
      Box({
        key,
        flexDirection: "row",
        flexWrap: "wrap",
        columnGap: 3,
        children,
      });
    const panel = Box({
      key: "panel",
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "subtle",
      borderDimColor: true,
      paddingX: 1,
      children: [row("status", status), row("controls", controls)],
    });

    const blocks = [panel];
    const unfinished = tasks.some((t) => t.status !== "completed");
    if (
      clean &&
      (unfinished || e.props.isWorking) &&
      (tasks.length || hidden)
    ) {
      blocks.push(planPanel(el, e.props.isWorking, e.props.bodyColumns ?? 120));
    }
    if (agents.length) blocks.push(agentsPanel(el));

    // Keep whatever other mods draw in the band
    const others = await next(e);
    return Box({
      flexDirection: "column",
      children: [...blocks, ...(others ? [others] : [])],
    });
  });
}

// ── drawing helpers ──

const levelColor = (pct) =>
  pct >= 80 ? "error" : pct >= 60 ? "warning" : "success";

function label(el, text) {
  return el.Text({ color: "subtle", dimColor: true, children: [text] });
}

// ── screen-share masking ──

const MASKS = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // email
  /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abpr]|AKIA)[-_A-Za-z0-9]{12,}/g, // API keys
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, // IPv4
  /[$€£]\s?\d[\d,.]*(?:\s?[kKmMbB]\b)?|\b\d[\d,.]*\s?(?:USD|EUR|GBP|dollars|euros)\b/g, // money
  /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)|\d{2,4})[ -]\d{3,4}[ -]\d{3,4}\b/g, // phone
];
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each match becomes a bar of its own length, so the layout does not move
function redact(text) {
  if (typeof text !== "string") return text;
  const bar = (m) => "▇".repeat(m.length);
  let out = MASKS.reduce((t, re) => t.replace(re, bar), text);
  for (const w of redactWords)
    out = out.replace(new RegExp(escapeRe(w), "gi"), bar);
  return out;
}

function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v)]),
    );
  return value;
}

// A thin meter, as in  ━━━━━━────── 42%
function meter(el, pct, width, color) {
  const filled = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * width);
  return el.Box({
    flexDirection: "row",
    flexShrink: 0,
    children: [
      el.Text({ color, children: ["━".repeat(filled)] }),
      el.Text({
        color: "subtle",
        dimColor: true,
        children: ["─".repeat(width - filled)],
      }),
    ],
  });
}

// The context meter, colored by how full it is, and its percentage
function ctxBar(el, pct, width) {
  return el.Box({
    flexDirection: "row",
    flexShrink: 0,
    children: [
      meter(el, pct, width, levelColor(pct)),
      el.Text({ color: levelColor(pct), children: [" " + pct + "%"] }),
    ],
  });
}

// ── plan panel ──

const SPIN = ["◐", "◓", "◑", "◒"]; // the working step's dot turns once a second

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

// The plan as the prompt it serves, an overall meter, and one row per step in Claude's order
function planPanel(el, isWorking, columns) {
  const { Box, Text } = el;
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const firstPending = tasks.findIndex((t) => t.status === "pending");
  const now = Date.now();

  const inner = Math.max(40, columns - 4);
  const nameWidth = Math.max(18, Math.floor(inner * 0.6));

  const raw =
    (share ? redact(promptTitle) : promptTitle) ?? "Working on the plan";
  const maxTitle = inner - 12;
  const title = raw.length > maxTitle ? raw.slice(0, maxTitle - 1) + "…" : raw;

  const head = Box({
    key: "head",
    flexDirection: "row",
    justifyContent: "space-between",
    children: [
      Box({
        key: "t",
        flexDirection: "row",
        columnGap: 1,
        children: [
          Text({ color: "claude", children: ["✦"] }),
          Text({ bold: true, children: [title] }),
        ],
      }),
      Text({
        color: "subtle",
        children: [
          turnStartedAt && isWorking ? elapsed(now - turnStartedAt) : "done",
        ],
      }),
    ],
  });

  const progress = Box({
    key: "progress",
    flexDirection: "row",
    columnGap: 1,
    marginBottom: 1,
    children: [
      meter(el, pct, Math.max(10, inner - 14), "claude"),
      Text({ color: "subtle", children: [done + "/" + total] }),
      Text({ bold: true, children: [String(pct).padStart(3) + "%"] }),
    ],
  });

  const rows = tasks.slice(0, PLAN_ROWS).map((t, i) => {
    const isDone = t.status === "completed";
    const isWorkingStep = t.status === "in_progress";
    const dot = isDone
      ? Text({ color: "success", children: ["✓ "] })
      : isWorkingStep
        ? Text({
            color: "claude",
            children: [SPIN[Math.floor(now / 1000) % SPIN.length] + " "],
          })
        : Text({ color: "subtle", dimColor: true, children: ["○ "] });
    const meta = isDone
      ? [
          Text({
            color: "subtle",
            dimColor: true,
            children: [elapsed((t.endedAt ?? now) - (t.startedAt ?? now))],
          }),
        ]
      : isWorkingStep
        ? [
            Text({ color: "claude", children: ["working"] }),
            Text({
              color: "subtle",
              children: [elapsed(now - (t.startedAt ?? now))],
            }),
          ]
        : i === firstPending
          ? [Text({ color: "subtle", children: ["next"] })]
          : [];
    return Box({
      key: "row-" + t.id,
      flexDirection: "row",
      justifyContent: "space-between",
      children: [
        Box({
          key: "name",
          width: nameWidth,
          flexShrink: 1,
          flexDirection: "row",
          children: [
            dot,
            Text({
              bold: isWorkingStep,
              color: isDone ? "subtle" : "text",
              dimColor: !isDone && !isWorkingStep,
              wrap: "truncate-end",
              children: [t.subject],
            }),
          ],
        }),
        Box({
          key: "meta",
          flexDirection: "row",
          columnGap: 1,
          flexShrink: 0,
          children: meta,
        }),
      ],
    });
  });
  if (tasks.length > PLAN_ROWS) {
    rows.push(
      Text({
        key: "more",
        color: "subtle",
        dimColor: true,
        children: ["  + " + (tasks.length - PLAN_ROWS) + " more"],
      }),
    );
  }
  if (!tasks.length && isWorking && hidden) {
    rows.push(
      Text({
        key: "hidden",
        color: "subtle",
        dimColor: true,
        children: [
          "  " +
            hidden +
            " tool calls hidden" +
            (lastTool ? " · " + lastTool : ""),
        ],
      }),
    );
  }

  return Box({
    key: "plan",
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "subtle",
    borderDimColor: true,
    paddingX: 1,
    children: [head, ...(total ? [progress] : []), ...rows],
  });
}

// ── agents panel ──

// One row per subagent: what it works on, its model, how far it got and what it spent
function agentsPanel(el) {
  const { Box, Text } = el;
  const now = Date.now();
  const running = agents.filter((a) => !a.endedAt).length;
  const head = Box({
    key: "head",
    flexDirection: "row",
    columnGap: 1,
    children: [
      Text({ bold: true, children: ["agents"] }),
      Text({ color: "subtle", children: ["·"] }),
      Text({
        color: running ? "claude" : "subtle",
        children: [running ? running + " running" : "all done"],
      }),
    ],
  });
  const rows = agents.map((a) => {
    const done = !!a.endedAt;
    const cell = (key, width, child) =>
      Box({ key, width, flexShrink: 0, children: [child] });
    return Box({
      key: "agent-" + a.id,
      flexDirection: "row",
      columnGap: 2,
      children: [
        Box({
          key: "name",
          width: 28,
          flexShrink: 1,
          flexDirection: "row",
          children: [
            done
              ? Text({ color: "success", children: ["✓ "] })
              : Text({
                  color: "claude",
                  children: [SPIN[Math.floor(now / 1000) % SPIN.length] + " "],
                }),
            Text({
              color: done ? "subtle" : "text",
              wrap: "truncate-end",
              children: [share ? redact(a.description) : a.description],
            }),
          ],
        }),
        cell("model", 6, Text({ color: "subtle", children: [a.model] })),
        cell(
          "steps",
          18,
          Text({
            color: done ? "success" : "subtle",
            wrap: "truncate-end",
            children: [
              done
                ? "done"
                : a.steps +
                  (a.steps === 1 ? " step" : " steps") +
                  (a.lastTool ? " · " + a.lastTool : ""),
            ],
          }),
        ),
        cell(
          "tokens",
          9,
          Text({
            color: "subtle",
            dimColor: true,
            children: [a.tokens ? fmtTokens(a.tokens) + " tok" : ""],
          }),
        ),
        Text({
          key: "time",
          color: "subtle",
          dimColor: true,
          children: [elapsed((a.endedAt ?? now) - a.startedAt)],
        }),
      ],
    });
  });
  return Box({
    key: "agents",
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "subtle",
    borderDimColor: true,
    paddingX: 1,
    children: [head, ...rows],
  });
}
