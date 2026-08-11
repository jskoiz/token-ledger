const MODEL_PRESENTATIONS = [
  {
    label: "Auto Review",
    colorKey: "autoReview",
    matches: (value) =>
      value === "auto-review" ||
      value === "codex-auto-review" ||
      value.startsWith("codex-auto-review-"),
  },
  {
    label: "Daybreak Blue",
    colorKey: "daybreakBlue",
    matches: (value) =>
      value === "daybreak-blue" || value.startsWith("gpt-daybreak-blue"),
  },
  {
    label: "Sol",
    colorKey: "sol",
    matches: (value) => value === "sol" || value.startsWith("gpt-5.6-sol"),
  },
  {
    label: "Luna",
    colorKey: "luna",
    matches: (value) => value === "luna" || value.startsWith("gpt-5.6-luna"),
  },
  {
    label: "Terra",
    colorKey: "terra",
    matches: (value) => value === "terra" || value.startsWith("gpt-5.6-terra"),
  },
  {
    label: "GPT-5.5 Cyber",
    colorKey: "gpt",
    matches: (value) => value.startsWith("gpt-5.5-cyber"),
  },
  {
    label: "GPT-5.5",
    colorKey: "gpt",
    matches: (value) => value === "gpt-5.5" || value.startsWith("gpt-5.5-"),
  },
  {
    label: "GPT-5.4 Mini",
    colorKey: "gpt",
    matches: (value) => value.startsWith("gpt-5.4-mini"),
  },
  {
    label: "GPT-5.4",
    colorKey: "gpt",
    matches: (value) => value === "gpt-5.4" || value.startsWith("gpt-5.4-"),
  },
  {
    label: "GPT-5.3 Codex",
    colorKey: "gpt",
    matches: (value) => value.startsWith("gpt-5.3-codex"),
  },
  {
    label: "GPT-5.2",
    colorKey: "gpt",
    matches: (value) => value === "gpt-5.2" || value.startsWith("gpt-5.2-"),
  },
  {
    label: "GPT",
    colorKey: "gpt",
    matches: (value) => value === "gpt",
  },
  {
    label: "Unknown model",
    colorKey: "other",
    matches: (value) => value === "unknown" || value === "unknown-model",
  },
];

function normalizedModel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
}

function presentationFor(value) {
  const normalized = normalizedModel(value);
  return MODEL_PRESENTATIONS.find((presentation) =>
    presentation.matches(normalized),
  );
}

export function modelDisplayName(value) {
  const model = String(value || "").trim();
  return presentationFor(model)?.label || model || "Unknown model";
}

export function modelColorKey(value) {
  return presentationFor(value)?.colorKey || "other";
}
