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
  pauseError = null,
  writeErrorWhen = null,
  deferWriteCallbacks = false,
} = {}) {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signalTarget = new EventEmitter();
  const state = {
    rawCalls: [],
    encodingCalls: [],
    resumeCalls: 0,
    pauseCalls: 0,
    writes: [],
    pendingWriteCallbacks: [],
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
      if (pauseError) throw pauseError;
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
      if (callback) {
        if (deferWriteCallbacks) state.pendingWriteCallbacks.push(callback);
        else callback();
      }
      return true;
    },
  });
  state.flushWriteCallbacks = () => {
    for (const callback of state.pendingWriteCallbacks.splice(0)) callback();
  };

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

function assertTerminalRestored(
  terminal,
  { rawCalls = [true, false], pauseCalls = 1 } = {},
) {
  assert.deepEqual(terminal.state.rawCalls, rawCalls);
  assert.equal(terminal.state.pauseCalls, pauseCalls);
  assert.ok(terminal.state.writes.at(-1)?.includes(SHOW_CURSOR));
  assert.ok(terminal.state.writes.at(-1)?.includes(EXIT_ALT_SCREEN));
  assertListenersRemoved(terminal);
}

test("interactive quit restores the prior stream state and is idempotent", async () => {
  const terminal = createTerminal({ rawMode: true, flowing: true });
  const session = start(terminal);

  terminal.stdin.emit("data", "q");
  await session;
  terminal.signalTarget.emit("SIGINT");

  assert.deepEqual(terminal.state.rawCalls, [true, true]);
  assert.equal(terminal.state.resumeCalls, 2);
  assert.equal(terminal.state.pauseCalls, 0);
  assert.equal(terminal.state.encodingCalls.length, 1);
  assert.ok(terminal.state.writes[0].includes(ENTER_ALT_SCREEN));
  assertTerminalRestored(terminal, { rawCalls: [true, true], pauseCalls: 0 });
});

test("setup failures tear down every mutation that was attempted", async () => {
  const cases = [
    {
      name: "raw mode",
      options: { setRawModeErrorFor: true },
      message: /setRawMode\(true\) failed/,
      pauseCalls: 0,
    },
    {
      name: "encoding",
      options: { encodingError: new Error("encoding failed") },
      message: /encoding failed/,
      pauseCalls: 0,
    },
    {
      name: "resume",
      options: { resumeError: new Error("resume failed") },
      message: /resume failed/,
      pauseCalls: 1,
    },
  ];

  for (const testCase of cases) {
    const terminal = createTerminal(testCase.options);
    const session = start(terminal);
    await assert.rejects(session, testCase.message, testCase.name);
    assert.equal(terminal.state.pauseCalls, testCase.pauseCalls);
    assertListenersRemoved(terminal);
  }
});

test("initial rendering failures restore terminal state", async () => {
  const terminal = createTerminal();
  const session = start(terminal, () => {
    throw new Error("initial render failed");
  });

  await assert.rejects(session, /initial render failed/);
  assertTerminalRestored(terminal);
});

test("input and resize rendering failures share teardown", async () => {
  for (const trigger of [
    (terminal) => terminal.stdin.emit("data", "j"),
    (terminal) => terminal.stdout.emit("resize"),
  ]) {
    const terminal = createTerminal();
    let renderCalls = 0;
    const session = start(terminal, () => {
      renderCalls += 1;
      if (renderCalls === 2) throw new Error("redraw failed");
      return "screen";
    });

    trigger(terminal);
    await assert.rejects(session, /redraw failed/);
    assert.equal(renderCalls, 2);
    assertTerminalRestored(terminal);
  }
});

test("output write failures share teardown", async () => {
  const terminal = createTerminal({
    writeErrorWhen: (_text, call) => call === 2 ? new Error("output failed") : null,
  });
  const session = start(terminal);

  await assert.rejects(session, /output failed/);
  assertTerminalRestored(terminal);
});

test("stream errors and supported signals share teardown", async () => {
  for (const stream of ["stdin", "stdout"]) {
    const terminal = createTerminal();
    const session = start(terminal);
    const error = new Error(`${stream} failed`);
    terminal[stream].emit("error", error);

    await assert.rejects(session, error);
    assertTerminalRestored(terminal);
  }

  const signalExitCodes = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 };
  for (const signal of Object.keys(signalExitCodes)) {
    const terminal = createTerminal();
    const session = start(terminal);
    terminal.signalTarget.emit(signal);

    await session;
    assert.equal(terminal.signalTarget.exitCode, signalExitCodes[signal]);
    assertTerminalRestored(terminal);
  }
});

test("signals re-raise only after terminal restoration flushes", async () => {
  const terminal = createTerminal({ deferWriteCallbacks: true });
  const signalOrder = [];
  terminal.signalTarget.pid = 123;
  terminal.signalTarget.kill = (_pid, signal) => {
    signalOrder.push({ signal, writes: terminal.state.writes.length });
  };
  const session = start(terminal);

  terminal.signalTarget.emit("SIGTERM");
  assert.deepEqual(signalOrder, []);
  assert.ok(terminal.state.writes.at(-1).includes(SHOW_CURSOR));

  terminal.state.flushWriteCallbacks();
  await session;
  assert.deepEqual(signalOrder, [{ signal: "SIGTERM", writes: 3 }]);
  assert.equal(terminal.signalTarget.exitCode, 143);
  assertListenersRemoved(terminal);
});

test("cleanup attempts remaining restoration steps after one failure", async () => {
  const terminal = createTerminal({
    setRawModeErrorFor: false,
  });
  const session = start(terminal);
  terminal.stdin.emit("data", "q");

  await assert.rejects(session, /setRawMode\(false\) failed/);
  assert.equal(terminal.state.pauseCalls, 1);
  assert.equal(terminal.state.writes.length, 3);
  assert.ok(terminal.state.writes.at(-1).includes(SHOW_CURSOR));
  assertListenersRemoved(terminal);
});
