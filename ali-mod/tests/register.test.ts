import { describe, expect, mock, test } from "claude-code/testing";

const BAND = {
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 120,
  } as any,
} as const;

// Answers every call the mod makes beneath it, from memory
// `files` are the heartbeat files in the sessions directory, by name
function world(
  on: any,
  sets: {
    config: unknown[];
    fills?: string[];
    writes?: Record<string, string>;
  },
  files: Record<string, object> = {},
  opts: { pct?: number } = {},
) {
  const writes = (sets.writes ??= {});
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  // What Claude Code itself draws beneath the mod: a tool row, else nothing
  on("ui.render", ($: any, e: any) => {
    const { Box, Text } = $.ui.resolve(e);
    if (e.component === "ToolUse") return Text({ children: ["Read a.kt"] });
    if (e.component === "AssistantMessage" || e.component === "UserMessage")
      return Text({ children: [e.props.text] });
    return Box({ children: [] });
  });
  const clock = mock.clock(on);
  mock.store(on);
  mock.env(on, { HOME: "/home/ali" });
  on("command.register", ($: any, e: any) => ({ value: { command: e.name } }));
  on("process.run", ($: any, e: any) => {
    const argv = e.argv.join(" ");
    if (argv.startsWith("git branch"))
      return { value: { exitCode: 0, stdout: "main\n", stderr: "" } };
    if (argv.startsWith("git status"))
      return { value: { exitCode: 0, stdout: " M a.kt\n", stderr: "" } };
    if (argv.endsWith("bin/ali health"))
      return {
        value: {
          exitCode: 0,
          stdout: "\x1b[1mAll services healthy\x1b[0m",
          stderr: "",
        },
      };
    return { value: { exitCode: 0, stdout: "Mac\n", stderr: "" } };
  });
  on("session.id", () => ({ value: "s1" }));
  on("session.cwd", () => ({ value: "/work/Lexicon" }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.usage", () => ({
    value: {
      context: { tokens: 120_000, window: 200_000, percent: opts.pct ?? 42 },
    },
  }));
  on("settings.read", () => ({ value: { effortLevel: "high" } }));
  on("fs.write", ($: any, e: any) => {
    writes[e.path] = e.content ?? e.text ?? e.data;
    return { value: undefined };
  });
  on("fs.list", () => ({
    value: Object.keys(files).map((name) => ({ name, kind: "file" })),
  }));
  on("fs.read", ($: any, e: any) => {
    if (e.path in writes) return { value: writes[e.path] };
    const f = files[e.path.split("/").pop()];
    if (!f) throw new Error("ENOENT " + e.path);
    return { value: JSON.stringify(f) };
  });
  on("prompt.fill", ($: any, e: any) => {
    (sets.fills ??= []).push(e.text);
    return { isFilled: true };
  });
  on("prompt.submit", ($: any, e: any) => ({ text: e.text }));
  on("turn.complete", () => ({ text: "" }));
  on("prompt.context", ($: any, e: any) => ({ blocks: e.blocks }));
  on("model.fork", () => ({
    value: {
      isAnswered: true,
      text: "## Goal\nShip the mod",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }));
  on("agent.spawn", () => ({ model: "claude-haiku-5-5", agentId: "a1" }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("config.set", ($: any, e: any) => {
    sets.config.push(e);
    return { value: e.value };
  });
  return { clock };
}

async function texts(ui: any) {
  return (await ui.findAll({ type: "Text" })).map((t: any) => t.text);
}

describe("register", () => {
  test("band draws nothing when nothing needs attention", async ($, on) => {
    world(on, { config: [] });
    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });
    const ui = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...BAND,
    });
    const all = await texts(ui);
    expect(all).toEqual([]);
    expect(await ui.find({ key: "clean" })).toBeUndefined();
  });

  test("sessions pane lists live sessions and skips dead ones", async ($, on) => {
    const now = Date.now();
    const files: Record<string, object> = {
      "s1.json": {
        id: "s1",
        host: "Mac",
        cwd: "/work/Lexicon",
        branch: "main",
        model: "claude-opus-5-5",
        pct: 42,
        working: false,
        at: now,
      },
      "s2.json": {
        id: "s2",
        host: "Mac",
        cwd: "/work/lexicon.server",
        branch: "dev",
        model: "claude-sonnet-5-5",
        pct: 10,
        working: true,
        at: now,
      },
      "s3.json": {
        id: "s3",
        host: "Mac",
        cwd: "/work/old",
        branch: null,
        model: "x",
        pct: 0,
        working: false,
        at: now - 60_000,
      },
    };
    world(on, { config: [] }, files);
    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });

    await $.command.run({ command: "sessions", args: "" } as any);
    const pane = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      component: "Pane",
      requestId: "ali-sessions",
      props: { title: "Sessions", isFocused: true, bodyColumns: 80 } as any,
    });
    const all = await texts(pane);
    expect(all).toContain("this session");
    expect(all).toContain("working");
    expect(all).toContain("idle");
    expect(all).toContain("lexicon.server");
    expect(all).toContain("⎇ dev");
    expect(all.some((t: string) => t.includes("old"))).toBe(false);
    expect(await pane.find({ key: "copy" })).toBeDefined();
  });

  test("cold cache holds the first send and puts the text back", async ($, on) => {
    const sets = { config: [] as any[], fills: [] as string[] };
    const { clock } = world(on, sets);
    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });
    await $.turn.complete({
      turnId: "t1",
      answer: "",
      durationMs: 1,
      isAborted: false,
      reason: "answer",
    } as any);

    const warm = await $.prompt.submit({ text: "next step" } as any);
    expect((warm as any)?.drop).toBeUndefined();

    await clock.advance(61 * 60_000);
    const ui = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...BAND,
      props: { ...BAND.props, isWorking: false },
    });
    expect(await texts(ui)).toContain("◌ cold");

    const held = await $.prompt.submit({
      text: "pick up where we left",
    } as any);
    expect((held as any)?.drop).toBeDefined();
    expect(sets.fills).toEqual(["pick up where we left"]);

    const sent = await $.prompt.submit({
      text: "pick up where we left",
    } as any);
    expect((sent as any)?.drop).toBeUndefined();
  });

  test("high context nudges /handoff, which saves a note the next chat loads", async ($, on) => {
    const sets = { config: [] as any[], writes: {} as Record<string, string> };
    world(on, sets, {}, { pct: 85 });
    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });
    const ui = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...BAND,
    });
    expect(await texts(ui)).toContain("↻ /handoff");

    const out: any = await $.command.run({
      command: "handoff",
      args: "",
    } as any);
    expect(out.text).toContain("Handoff saved");
    const path = Object.keys(sets.writes).find((p) => p.includes("/handoff/"));
    expect(path).toBeDefined();
    expect(sets.writes[path!]).toContain("Ship the mod");

    const ctx: any = await $.prompt.context({ blocks: [] } as any);
    const block = ctx.blocks.find((b: any) => b.name === "handoff");
    expect(block.text).toContain("Ship the mod");
  });

  test("screen-share mode masks private details in messages", async ($, on) => {
    world(on, { config: [] }, {});
    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });
    const MSG = {
      component: "AssistantMessage",
      props: {
        text: "Mail ali@example.com, paid $1,200 to Acme on 148.230.109.213 (v2.1.308, 2026-11-02)",
        isFirstOfReply: true,
      } as any,
      requestId: "m1",
    } as const;

    const before = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...MSG,
    });
    expect((await texts(before)).join(" ")).toContain("ali@example.com");
    await before.unmount();

    await $.command.run({ command: "screenshare", args: "add Acme" } as any);
    await $.command.run({ command: "screenshare", args: "" } as any);
    const after = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...MSG,
    });
    const shown = (await texts(after)).join(" ");
    for (const secret of [
      "ali@example.com",
      "$1,200",
      "Acme",
      "148.230.109.213",
    ])
      expect(shown).not.toContain(secret);
    expect(shown).toContain("▇");
    expect(shown).toContain("v2.1.308");
    expect(shown).toContain("2026-11-02");
  });

  test("subagent panel shows each subagent and when it finishes", async ($, on) => {
    world(on, { config: [] });
    on("tool.call", () => ({ result: "ok" }));
    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });
    await $.agent.spawn({
      tool_use_id: "tu1",
      prompt: "p",
      description: "Research the API",
      subagentType: "general-purpose",
    } as any);
    await $.tool.call({ tool: "Read", agentId: "a1", file_path: "/x" } as any);
    await $.tool.call({ tool: "Grep", agentId: "a1", pattern: "y" } as any);

    const ui = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...BAND,
    });
    let all = await texts(ui);
    expect(all).toContain("Research the API");
    expect(all).toContain("haiku");
    expect(all).toContain("2 steps · Grep");

    await $.tool.call({
      tool: "Agent",
      tool_use_id: "tu1",
      description: "Research the API",
      prompt: "p",
    } as any);
    all = await texts(ui);
    expect(all).toContain("done");
  });

  test("desktop band draws a themed card without text glyphs", async ($, on) => {
    world(on, { config: [] });
    await $.session.start({
      surface: "desktop",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });
    const ui = await $.ui.mount({
      plugin: "ali-mod",
      surface: "desktop",
      ...BAND,
    });
    await $.command.run({ command: "screenshare", args: "" } as any);
    const all = await texts(ui);
    expect(all).toContain("SCREEN SHARE");
    // Box-drawing and block glyphs misalign in a proportional font
    expect(all.some((t: string) => /[╭╰│▰▱━]/.test(t))).toBe(false);
  });
});
