import { renderFullscreen, SCREEN_BASE } from "./token-ledger-terminal.mjs";
import { actionFor } from "./token-ledger-controls.mjs";

export { actionFor };

const ENTER_ALT_SCREEN = "\u001b[?1049h";
const EXIT_ALT_SCREEN = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const RESET = "\u001b[0m";

export function startInteractive(view) {
  const {
    options,
    snapshot,
    snapshotFreshness,
    bounds,
    events,
    rows,
    allRows,
  } = view;
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Interactive mode requires a terminal. Use --static when redirecting output.");
  }

  return new Promise((resolve, reject) => {
    let selectedIndex = 0;
    let closed = false;

    const draw = () => {
      const width = Math.max(40, stdout.columns || 120);
      const height = Math.max(12, stdout.rows || 32);
      const screen = renderFullscreen({
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
    };

    const finish = (error = null) => {
      if (closed) return;
      closed = true;
      stdin.off("data", onData);
      stdout.off("resize", draw);
      process.off("SIGINT", onSignal);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${RESET}${SHOW_CURSOR}${EXIT_ALT_SCREEN}`);
      if (error) reject(error);
      else resolve();
    };

    const onSignal = () => finish();
    const onData = (input) => {
      const action = actionFor(input);
      if (action === "quit") {
        finish();
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
        return;
      }
    };

    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
    stdout.on("resize", draw);
    process.once("SIGINT", onSignal);
    stdout.write(`${ENTER_ALT_SCREEN}${SCREEN_BASE}${HIDE_CURSOR}${CLEAR_SCREEN}`);
    draw();
  });
}
