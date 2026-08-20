export const INTERACTIVE_KEY_INPUTS = Object.freeze({
  up: Object.freeze(["\u001b[A", "k"]),
  down: Object.freeze(["\u001b[B", "j"]),
  quit: Object.freeze(["q", "Q", "\u0003", "\u001b"]),
});

export const INTERACTIVE_FOOTER = Object.freeze({
  ascii: "[j/k] select   [q/Q/esc/ctrl-c] quit",
  unicode: "[↑↓/j/k] select   [q/Q/esc/ctrl-c] quit",
});

export const INTERACTIVE_HELP = "↑/↓ or j/k move   •   q/Q, esc, or ctrl-c quit";

export function actionFor(input) {
  const value = String(input);
  if (value.includes(INTERACTIVE_KEY_INPUTS.up[0]) || value === INTERACTIVE_KEY_INPUTS.up[1]) {
    return "up";
  }
  if (value.includes(INTERACTIVE_KEY_INPUTS.down[0]) || value === INTERACTIVE_KEY_INPUTS.down[1]) {
    return "down";
  }
  if (INTERACTIVE_KEY_INPUTS.quit.includes(value)) return "quit";
  return null;
}
