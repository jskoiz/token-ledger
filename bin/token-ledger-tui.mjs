import { renderFullscreen, SCREEN_BASE } from "./token-ledger-terminal.mjs";
import { actionFor } from "./token-ledger-controls.mjs";

export { actionFor };

const ENTER_ALT_SCREEN = "\u001b[?1049h";
const EXIT_ALT_SCREEN = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const RESET = "\u001b[0m";
const SUPPORTED_SIGNALS = ["SIGINT", "SIGHUP", "SIGTERM"];
const SIGNAL_EXIT_CODES = {
  SIGINT: 2,
  SIGHUP: 1,
  SIGTERM: 15,
};

export function startInteractive(view, {
  stdin = process.stdin,
  stdout = process.stdout,
  signalTarget = process,
  render = renderFullscreen,
} = {}) {
  const {
    options,
    snapshot,
    snapshotFreshness,
    bounds,
    events,
    rows,
    allRows,
  } = view;
  // Interactive mode needs a raw-mode-capable terminal on both ends. Capture
  // the capability once here; the handlers below rely on it unconditionally.
  const setRawMode =
    stdin.isTTY && stdout.isTTY ? stdin.setRawMode?.bind(stdin) : null;
  if (!setRawMode) {
    throw new Error("Interactive mode requires a terminal. Use --static when redirecting output.");
  }

  return new Promise((resolve, reject) => {
    let selectedIndex = 0;
    let closed = false;
    let rawModeTouched = false;
    let streamFlowTouched = false;
    let terminalStateTouched = false;
    const previousRawMode = stdin.isRaw === true;
    const previousFlowing = stdin.readableFlowing;
    const registrations = [];

    const registerListener = (target, event, handler, method = "on") => {
      const registration = { target, event, handler };
      registrations.push(registration);
      target[method](event, handler);
    };

    const attemptCleanup = (cleanupErrors, action) => {
      try {
        action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    function teardown(error = null) {
      if (closed) return;
      closed = true;
      const cleanupErrors = [];

      for (const { target, event, handler } of registrations.splice(0)) {
        attemptCleanup(cleanupErrors, () => target.off(event, handler));
      }
      if (rawModeTouched) {
        attemptCleanup(cleanupErrors, () => setRawMode(previousRawMode));
      }
      if (streamFlowTouched) {
        attemptCleanup(cleanupErrors, () => {
          if (previousFlowing === true) stdin.resume();
          else stdin.pause();
        });
      }
      if (terminalStateTouched) {
        attemptCleanup(cleanupErrors, () => {
          stdout.write(`${RESET}${SHOW_CURSOR}${EXIT_ALT_SCREEN}`);
        });
      }

      if (error !== null) reject(error);
      else if (cleanupErrors.length > 0) reject(cleanupErrors[0]);
      else resolve();
    }

    function draw() {
      if (closed) return;
      try {
        const width = Math.max(40, stdout.columns || 120);
        const height = Math.max(12, stdout.rows || 32);
        const screen = render({
          options: { ...options, forceColor: true, selectedIndex },
          snapshot,
          snapshotFreshness,
          bounds,
          events,
          rows,
          allRows,
          width,
          height,
        });
        stdout.write(`${SCREEN_BASE}${CLEAR_SCREEN}${screen}`);
      } catch (drawError) {
        teardown(drawError);
      }
    }

    function onSignal(signal) {
      teardown();
      const exitCode = 128 + SIGNAL_EXIT_CODES[signal];
      signalTarget.exitCode = exitCode;
      if (signalTarget.pid) {
        signalTarget.kill(signalTarget.pid, signal);
      }
    }

    function onStreamError(streamError) {
      teardown(streamError ?? new Error("Interactive stream failed."));
    }

    function onData(input) {
      if (closed) return;
      try {
        const action = actionFor(input);
        if (action === "quit") {
          teardown();
          return;
        }
        if (action === "up") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          draw();
          return;
        }
        if (action === "down") {
          selectedIndex = Math.min(Math.max(0, rows.length - 1), selectedIndex + 1);
          draw();
        }
      } catch (inputError) {
        teardown(inputError);
      }
    }

    try {
      registerListener(stdin, "error", onStreamError);
      registerListener(stdout, "error", onStreamError);
      for (const signal of SUPPORTED_SIGNALS) {
        registerListener(signalTarget, signal, () => onSignal(signal), "once");
      }
      rawModeTouched = true;
      setRawMode(true);
      stdin.setEncoding("utf8");
      streamFlowTouched = true;
      stdin.resume();
      registerListener(stdin, "data", onData);
      registerListener(stdout, "resize", draw);
      terminalStateTouched = true;
      stdout.write(`${ENTER_ALT_SCREEN}${SCREEN_BASE}${HIDE_CURSOR}${CLEAR_SCREEN}`);
      draw();
    } catch (setupError) {
      teardown(setupError);
    }
  });
}
