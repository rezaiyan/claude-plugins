// ali-mod: one band above the prompt for daily work.
//   ops       zero-token /health and /vps
//   sessions  every session writes a heartbeat file; /sessions lists live ones (Mac + Pi)
//   cache     warns before a message re-reads a chat whose prompt cache went cold
//   handoff   at high context, /handoff saves a note the next chat in this folder starts from
//   share     /screenshare masks emails, keys, IPs, amounts and chosen words on screen
//   agents    one row per running subagent: model, steps, last tool, tokens, time
// Claude Code allows one hooks module per plugin and one hook per event, so all parts live here.

const MODELS = ["opus", "sonnet", "haiku"];
const GIT_EVERY_MS = 15_000;

const TOOL_SITES = /^Tool(Use|Result|Group|Progress)$/;

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
  redraw($);
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

    const words = await $.store.get("redact");
    redactWords = Array.isArray(words) ? words : [];
    dir = (await $.env.get("HOME")) + "/.claude/ali-mod/sessions";
    const host = await $.process.run(["hostname", "-s"]);
    me = { id: await $.session.id(), host: host.stdout.trim() || "mac" };

    // Fire and forget, so session start is not blocked by git, network or disk
    refreshGit($)
      .then(() => beat($))
      .then(() => readLocal($))
      .catch(() => {});
    $.clock.every(GIT_EVERY_MS, () => refreshGit($));
    $.clock.every(BEAT_EVERY_MS, async () => {
      await beat($);
      await readLocal($);
    });
    $.clock.every(PI_EVERY_MS, async () => {
      if (paneOpen) await readPi($);
    });
    // The plan's clock and activity cells move each second while Claude works
    $.clock.every(1000, () => {
      if (agents.some((a) => !a.endedAt)) redraw($);
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
    return next(e);
  }).catch(($, e, next) => next(e));

  on("turn.start", async ($, e, next) => {
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
    const response = yield* next(e);
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
    const result = await next(e);
    if (e.tool === "Agent" || e.tool === "Task") {
      for (const a of agents)
        if (a.toolUseId === e.tool_use_id && !a.endedAt) a.endedAt = Date.now();
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

  on("ui.render", { component: TOOL_SITES }, async ($, e, next) => {
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
    const el = resolveUi($, e);
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
    const el = resolveUi($, e);
    const usage = await $.session.usage();
    const columns = e.props.bodyColumns ?? 120;

    // What the band shows, gathered once and drawn per surface
    const d = {
      pct: Math.round(usage?.context?.percent ?? 0),
      cache: null,
      handoff: false,
      share,
    };
    d.handoff = d.pct >= HANDOFF_AT;
    if (lastReplyAt !== null && !e.props.isWorking) {
      const left = CACHE_TTL_MS - ((await $.clock.now()) - lastReplyAt);
      if (left <= 0) d.cache = { cold: true, minutes: 0 };
      else if (left <= CACHE_SOON_MS)
        d.cache = { cold: false, minutes: Math.ceil(left / 60_000) };
    }

    // Nothing needs attention: the band stays empty
    const blocks = bandCards(d).length
      ? [isRich(el) ? cardsRich(el, d) : cardsTerminal(el, d)]
      : [];
    if (agents.length) blocks.push(agentsPanel(el, columns));

    // Keep whatever other mods draw in the band
    const others = await next(e);
    return el.Box({
      flexDirection: "column",
      rowGap: isRich(el) ? 1 : 0,
      children: [...blocks, ...(others ? [others] : [])],
    });
  });
}

// ── band: cards ──

// The cards the band shows, each { key, label, accent, parts }
// `parts` are runs of text with their own color
function bandCards(d) {
  const cards = [];
  if (d.cache)
    cards.push({
      key: "cache",
      label: "CACHE",
      accent: d.cache.cold ? "warning" : "subtle",
      parts: d.cache.cold
        ? [{ text: "◌ cold", color: "warning", bold: true }]
        : [{ text: "◷ " + d.cache.minutes + "m left", color: "text" }],
    });
  if (d.handoff)
    cards.push({
      key: "handoff",
      label: "HANDOFF",
      accent: levelColor(d.pct),
      parts: [
        { text: "↻ /handoff", color: levelColor(d.pct), bold: true },
        { text: " · " + d.pct + "% full", color: "subtle" },
      ],
    });
  if (d.share)
    cards.push({
      key: "share",
      label: "SCREEN SHARE",
      accent: "error",
      parts: [
        { text: "● ", color: "error" },
        { text: "masking", color: "text" },
      ],
    });
  return cards;
}

const partsLength = (parts) => parts.reduce((n, p) => n + p.text.length, 0);

function runs(el, parts) {
  return el.Box({
    flexDirection: "row",
    flexShrink: 0,
    children: parts.map((p, i) =>
      el.Text({
        key: "p" + i,
        color: p.color,
        bold: p.bold,
        dimColor: p.dim,
        children: [p.text],
      }),
    ),
  });
}

// Terminal: each card a box with its label set into the top border
function cardsTerminal(el, d) {
  return el.Box({
    key: "cards",
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 1,
    children: bandCards(d).map((c) => {
      return frame(el, {
        key: c.key,
        label: c.label,
        accent: c.accent,
        width: Math.max(c.label.length + 6, partsLength(c.parts) + 4),
        rows: [runs(el, c.parts)],
      });
    }),
  });
}

// Desktop and other rich surfaces: bordered cards themed by the host
function cardsRich(el, d) {
  const { Box, Text } = el;
  return Box({
    key: "cards",
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 1,
    rowGap: 1,
    children: bandCards(d).map((c) =>
      Box({
        key: c.key,
        flexDirection: "row",
        alignItems: "center",
        columnGap: 1,
        borderStyle: "round",
        borderColor: c.accent === "subtle" ? "subtle" : c.accent,
        paddingX: 1,
        children: [
          Box({
            key: "text",
            flexDirection: "column",
            children: [
              Text({
                key: "label",
                color: "subtle",
                bold: true,
                children: [c.label],
              }),
              runs(el, c.parts),
            ],
          }),
        ],
      }),
    ),
  });
}

// ── drawing helpers ──

const levelColor = (pct) =>
  pct >= 80 ? "error" : pct >= 60 ? "warning" : "success";

// The terminal draws text cells only; every other surface has Svg and a proportional font.
// A table answers any element name (an unknown one draws a fragment), so ask the surface.
const richTables = new WeakMap();
function resolveUi($, e) {
  const el = $.ui.resolve(e);
  richTables.set(el, e.surface !== "terminal");
  return el;
}
const isRich = (el) => richTables.get(el) === true;

// Theme colors as hex for SVG, mid tones that read on light and dark alike
const HEX = {
  success: "#2ea043",
  warning: "#d29922",
  error: "#e5534b",
  claude: "#d97757",
  suggestion: "#7c8cf8",
  planMode: "#3fb6a8",
};
const hex = (c) => HEX[c] ?? (c?.startsWith("#") ? c : "#8b929b");
const TRACK = "rgba(127,127,127,.25)";

// A box drawn from text with its label set into the top border:  ╭─ LABEL ───╮
function frame(el, { key, label, accent, width, rows }) {
  const { Box, Text } = el;
  const edge = { color: "subtle", dimColor: true };
  const fill = Math.max(0, width - 5 - label.length);
  return Box({
    key,
    flexDirection: "column",
    flexShrink: 0,
    width,
    children: [
      Box({
        key: "top",
        flexDirection: "row",
        children: [
          Text({ key: "a", ...edge, children: ["╭─ "] }),
          Text({ key: "l", color: accent, bold: true, children: [label] }),
          Text({ key: "b", ...edge, children: [" " + "─".repeat(fill) + "╮"] }),
        ],
      }),
      ...rows.map((row, i) =>
        Box({
          key: "row" + i,
          flexDirection: "row",
          children: [
            Text({ key: "l", ...edge, children: ["│ "] }),
            Box({
              key: "in",
              width: width - 4,
              flexShrink: 0,
              flexDirection: "row",
              overflow: "hidden",
              children: [row],
            }),
            Text({ key: "r", ...edge, children: [" │"] }),
          ],
        }),
      ),
      Text({
        key: "bottom",
        ...edge,
        children: ["╰" + "─".repeat(width - 2) + "╯"],
      }),
    ],
  });
}

// ▰▰▰▰▱▱: each filled cell colored by how full the meter is there, or all in `color`
function blocks(el, pct, width, color) {
  const filled = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * width);
  const cells = Array.from({ length: width }, (_, i) =>
    i < filled
      ? { glyph: "▰", color: color ?? levelColor(((i + 1) / width) * 100) }
      : { glyph: "▱", color: "subtle" },
  );
  const grouped = [];
  for (const c of cells) {
    const last = grouped[grouped.length - 1];
    if (last && last.color === c.color && last.glyph === c.glyph)
      last.text += c.glyph;
    else grouped.push({ ...c, text: c.glyph });
  }
  return el.Box({
    flexDirection: "row",
    flexShrink: 0,
    children: grouped.map((g, i) =>
      el.Text({
        key: "c" + i,
        color: g.color,
        dimColor: g.color === "subtle",
        children: [g.text],
      }),
    ),
  });
}

// A rounded progress bar, filled with a soft gradient of `color`
function bar(el, pct, width, color, alt) {
  const fill = Math.round((width * Math.min(Math.max(pct, 0), 100)) / 100);
  const c = hex(color);
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">` +
    `<defs><linearGradient id="g"><stop offset="0" stop-color="${c}" stop-opacity=".65"/>` +
    `<stop offset="1" stop-color="${c}"/></linearGradient></defs>` +
    `<rect width="${width}" height="8" rx="4" fill="${TRACK}"/>` +
    (fill > 0
      ? `<rect width="${Math.max(fill, 8)}" height="8" rx="4" fill="url(#g)"/>`
      : "") +
    "</svg>";
  return el.Svg({ key: "bar", source, alt, width, height: 8 });
}

// The context meter of a session row, and its percentage
function ctxBar(el, pct, width) {
  return el.Box({
    flexDirection: "row",
    flexShrink: 0,
    alignItems: "center",
    columnGap: 1,
    children: [
      isRich(el)
        ? bar(el, pct, width * 8, levelColor(pct), "Context " + pct + "%")
        : blocks(el, pct, width),
      el.Text({ key: "pct", color: levelColor(pct), children: [pct + "%"] }),
    ],
  });
}

// ── plan panel ──

const SPIN = ["◐", "◓", "◑", "◒"]; // a running step's dot turns once a second
const spin = (now) => SPIN[Math.floor(now / 1000) % SPIN.length];

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

// A card holding rows, as each surface draws one: a text frame, or a themed box
function panel(el, { key, label, accent, columns, rows }) {
  if (!isRich(el))
    return frame(el, {
      key,
      label,
      accent,
      width: Math.max(44, columns - 2),
      rows,
    });
  return el.Box({
    key,
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "subtle",
    paddingX: 1,
    rowGap: 0,
    children: [
      el.Text({ key: "label", color: accent, bold: true, children: [label] }),
      ...rows,
    ],
  });
}

// ── agents panel ──

// One row per subagent: what it works on, its model, how far it got and what it spent
function agentsPanel(el, columns) {
  const { Box, Text } = el;
  const now = Date.now();
  const running = agents.filter((a) => !a.endedAt).length;
  const cell = (key, width, child) =>
    Box({ key, width, flexShrink: 0, children: [child] });
  const rows = agents.map((a) => {
    const done = !!a.endedAt;
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
              ? Text({ key: "d", color: "success", children: ["✓ "] })
              : Text({
                  key: "d",
                  color: "claude",
                  children: [spin(now) + " "],
                }),
            Text({
              key: "s",
              color: done ? "subtle" : "text",
              wrap: "truncate-end",
              children: [share ? redact(a.description) : a.description],
            }),
          ],
        }),
        cell("model", 6, Text({ color: "planMode", children: [a.model] })),
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
  return panel(el, {
    key: "agents",
    label: running ? "AGENTS · " + running + " RUNNING" : "AGENTS · ALL DONE",
    accent: running ? "claude" : "success",
    columns,
    rows,
  });
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
