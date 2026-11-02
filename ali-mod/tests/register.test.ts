import { describe, expect, mock, test } from "claude-code/testing";

const BAND = {
  component: "AbovePrompt",
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 120 } as any,
} as const;

// Answers every call the mod makes beneath it, from memory
// `files` are the heartbeat files in the sessions directory, by name
function world(
  on: any,
  sets: { config: unknown[] },
  files: Record<string, object> = {},
) {
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  // What Claude Code itself draws beneath the mod: a tool row, else nothing
  on("ui.render", ($: any, e: any) => {
    const { Box, Text } = $.ui.resolve(e);
    return e.component === "ToolUse"
      ? Text({ children: ["Read a.kt"] })
      : Box({ children: [] });
  });
  mock.clock(on);
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
    value: { context: { tokens: 1, window: 1, percent: 42 } },
  }));
  on("settings.read", () => ({ value: { effortLevel: "high" } }));
  on("fs.write", () => ({ value: undefined }));
  on("fs.list", () => ({
    value: Object.keys(files).map((name) => ({ name, kind: "file" })),
  }));
  on("fs.read", ($: any, e: any) => ({
    value: JSON.stringify(files[e.path.split("/").pop()]),
  }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("config.set", ($: any, e: any) => {
    sets.config.push(e);
    return { value: e.value };
  });
}

async function texts(ui: any) {
  return (await ui.findAll({ type: "Text" })).map((t: any) => t.text);
}

describe("register", () => {
  test("band shows ctx, git, prod and the model buttons", async ($, on) => {
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
    expect(all).toContain("ctx");
    expect(all).toContain(" 42%");
    expect(all).toContain("⎇ main");
    expect(all).toContain("*");
    expect(all).toContain("prod");
    expect(all).not.toContain(" PROD ✓ ");
    expect(await ui.find({ key: "model-opus" })).toBeDefined();
    expect(all).not.toContain(" CTX ");
  });

  test("pressing a model button sets the model row", async ($, on) => {
    const sets = { config: [] as any[] };
    world(on, sets);
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
    await ui.press({ key: "model-sonnet" });
    expect(sets.config.map((e) => [e.key, e.value])).toEqual([
      ["model", "sonnet"],
    ]);
  });

  test("clean view lists the plan from TaskCreate and TaskUpdate", async ($, on) => {
    world(on, { config: [] });
    on("tool.call", ($: any, e: any) => ({
      result: e.tool === "TaskCreate" ? "Task #7 created successfully" : "ok",
    }));
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
    await ui.press({ key: "clean" });

    await $.tool.call({
      tool: "TaskCreate",
      subject: "Write the test",
      description: "d",
    } as any);
    await $.tool.call({
      tool: "TaskUpdate",
      taskId: "7",
      status: "in_progress",
    } as any);
    const all = await texts(ui);
    expect(all).toContain("0/1");
    expect(all).toContain("  0%");
    expect(all).toContain("Write the test");
    expect(all).toContain("working");
  });

  test("clean view hides tool rows, and shows them again when off", async ($, on) => {
    world(on, { config: [] });
    await $.session.start({
      surface: "terminal",
      isInteractive: true,
      cwd: "/work/Lexicon",
    });
    const TOOL = {
      component: "ToolUse",
      props: { tool: "Read", input: {} } as any,
      requestId: "t1",
    } as const;

    const before = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...TOOL,
    });
    expect(await texts(before)).toContain("Read a.kt");
    await before.unmount();

    await $.command.run({ command: "clean", args: "" } as any);
    const after = await $.ui.mount({
      plugin: "ali-mod",
      surface: "terminal",
      ...TOOL,
    });
    expect(await texts(after)).toEqual([]);
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
});
