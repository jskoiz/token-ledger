import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { startInteractive } from "../bin/token-ledger-tui.mjs";

const ENTER_ALT_SCREEN = "\u001b[?1049h";
const EXIT_ALT_SCREEN = "\u001b[?1049l";
const SHOW_CURSOR = "\u001b[?25h";

function createTerminal({
  rawMode = false,
  flowing = null,
  setRawModeErrorFor = null,
  encodingError = null,
  resumeError = null,
  writeErrorWhen = null,
} = {}) {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signalTarget = new EventEmitter();
  const state = {
    rawCalls: [],
    pauseCalls: 0,
    resumeCalls: 0,
    encodingCalls: [],
    writes: [],
    kills: [],
  };

  Object.assign(stdin, {
    isTTY: true,
    isRaw: rawMode,
    readableFlowing: flowing,
    setRawMode(value) {
      state.rawCalls.push(value);
      if (value === setRawModeErrorFor) {
        throw new Error(`setRawMode(${String(value)}) failed`);
      }
      this.isRaw = value;
    },
    setEncoding(value) {
      state.encodingCalls.push(value);
      if (encodingError) throw encodingError;
    },
    resume() {
      state.resumeCalls += 1;
      if (resumeError) throw resumeError;
      this.readableFlowing = true;
    },
    pause() {
      state.pauseCalls += 1;
      this.readableFlowing = false;
    },
  });
  Object.assign(stdout, {
    isTTY: true,
    columns: 120,
    rows: 32,
    write(value, callback) {
      const text = String(value);
      state.writes.push(text);
      const error = writeErrorWhen?.(text, state.writes.length);
      if (error) throw error;
      callback?.();
      return true;
    },
  });
  signalTarget.pid = 123;
  signalTarget.kill = (pid, signal) => state.kills.push({ pid, signal });

  return { stdin, stdout, signalTarget, state };
}

function view() {
  return {
    options: {},
    snapshot: {},
    snapshotFreshness: {},
    bounds: {},
    events: [],
    rows: [{}],
    allRows: [{}],
  };
}

function start(terminal, render = () => "screen") {
  return startInteractive(view(), {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signalTarget: terminal.signalTarget,
    render,
  });
}

function assertListenersRemoved(terminal) {
  assert.equal(terminal.stdin.listenerCount("error"), 0);
  assert.equal(terminal.stdin.listenerCount("data"), 0);
  assert.equal(terminal.stdout.listenerCount("error"), 0);
  assert.equal(terminal.stdout.listenerCount("resize"), 0);
  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
    assert.equal(terminal.signalTarget.listenerCount(signal), 0);
  }
}

function assertRestored(terminal, { rawCalls = [true, false], pauseCalls = 1 } = {}) {
  assert.deepEqual(terminal.state.rawCalls, rawCalls);
  assert.equal(terminal.state.pauseCalls, pauseCalls);
  assert.ok(terminal.state.writes[0].includes(ENTER_ALT_SCREEN));
  assert.ok(terminal.state.writes.at(-1)?.includes(SHOW_CURSOR));
  assert.ok(terminal.state.writes.at(-1)?.includes(EXIT_ALT_SCREEN));
  assertListenersRemoved(terminal);
}

test("quit and supported signals restore terminal state", async () => {
  const cases = [
    {
      name: "quit from a non-raw paused stream",
      trigger: (terminal) => terminal.stdin.emit("data", "q"),
      expectedRawCalls: [true, false],
      expectedPauseCalls: 1,
    },
    {
      name: "quit preserves an already raw flowing stream",
      options: { rawMode: true, flowing: true },
      trigger: (terminal) => terminal.stdin.emit("data", "q"),
      expectedRawCalls: [true, true],
      expectedPauseCalls: 0,
    },
    ...[
      ["SIGINT", 130],
      ["SIGHUP", 129],
      ["SIGTERM", 143],
    ].map(([signal, exitCode]) => ({
      name: signal,
      trigger: (terminal) => terminal.signalTarget.emit(signal),
      signal,
      exitCode,
      expectedRawCalls: [true, false],
      expectedPauseCalls: 1,
    })),
  ];

  for (const testCase of cases) {
    const terminal = createTerminal(testCase.options);
    const session = start(terminal);
    testCase.trigger(terminal);
    await session;

    assertRestored(terminal, {
      rawCalls: testCase.expectedRawCalls,
      pauseCalls: testCase.expectedPauseCalls,
    });
    if (testCase.signal) {
      assert.equal(terminal.signalTarget.exitCode, testCase.exitCode, testCase.name);
      assert.deepEqual(terminal.state.kills, [
        { pid: 123, signal: testCase.signal },
      ], testCase.name);
    }
  }
});

test("setup, render, stream, and output failures restore what was touched", async () => {
  const cases = [
    {
      name: "raw-mode setup",
      options: { setRawModeErrorFor: true },
      error: /setRawMode\(true\) failed/,
      expectedRawCalls: [true, false],
      expectedPauseCalls: 0,
      restored: false,
    },
    {
      name: "encoding setup",
      options: { encodingError: new Error("encoding failed") },
      error: /encoding failed/,
      expectedRawCalls: [true, false],
      expectedPauseCalls: 0,
      restored: false,
    },
    {
      name: "resume setup",
      options: { resumeError: new Error("resume failed") },
      error: /resume failed/,
      expectedRawCalls: [true, false],
      expectedPauseCalls: 1,
      restored: false,
    },
    {
      name: "initial render",
      error: /render failed/,
      render: () => {
        throw new Error("render failed");
      },
      restored: true,
    },
    {
      name: "stdin stream",
      error: /stdin failed/,
      trigger: (terminal) => terminal.stdin.emit("error", new Error("stdin failed")),
      restored: true,
    },
    {
      name: "stdout stream",
      error: /stdout failed/,
      trigger: (terminal) => terminal.stdout.emit("error", new Error("stdout failed")),
      restored: true,
    },
    {
      name: "output write",
      options: {
        writeErrorWhen: (_text, call) =>
          call === 2 ? new Error("output failed") : null,
      },
      error: /output failed/,
      restored: true,
    },
  ];

  for (const testCase of cases) {
    const terminal = createTerminal(testCase.options);
    const session = start(terminal, testCase.render);
    if (testCase.trigger) testCase.trigger(terminal);
    const rejection = assert.rejects(session, testCase.error, testCase.name);
    await rejection;

    if (testCase.restored) {
      assertRestored(terminal);
    } else {
      assert.deepEqual(terminal.state.rawCalls, testCase.expectedRawCalls, testCase.name);
      assert.equal(terminal.state.pauseCalls, testCase.expectedPauseCalls, testCase.name);
      assert.equal(terminal.state.writes.length, 0, testCase.name);
      assertListenersRemoved(terminal);
    }
  }
});

test("repeated cleanup is safe and remaining restoration steps still run", async () => {
  const repeatCases = [
    {
      name: "second quit",
      repeat: (terminal) => terminal.stdin.emit("data", "q"),
    },
    {
      name: "signal after quit",
      repeat: (terminal) => terminal.signalTarget.emit("SIGINT"),
    },
  ];

  for (const testCase of repeatCases) {
    const terminal = createTerminal();
    const session = start(terminal);
    terminal.stdin.emit("data", "q");
    await session;
    testCase.repeat(terminal);

    assertRestored(terminal);
    assert.equal(terminal.state.writes.length, 3, testCase.name);
    assert.equal(terminal.state.kills.length, 0, testCase.name);
  }

  const terminal = createTerminal({ setRawModeErrorFor: false });
  const session = start(terminal);
  terminal.stdin.emit("data", "q");
  await assert.rejects(session, /setRawMode\(false\) failed/);
  assert.equal(terminal.state.pauseCalls, 1);
  assert.equal(terminal.state.writes.length, 3);
  assert.ok(terminal.state.writes.at(-1).includes(SHOW_CURSOR));
  assert.ok(terminal.state.writes.at(-1).includes(EXIT_ALT_SCREEN));
  assertListenersRemoved(terminal);
});
