const MODEL_PRESENTATIONS = [
  {
    canonical: "codex-auto-review",
    families: ["auto-review", "codex-auto-review"],
    label: "Auto Review",
    colorKey: "autoReview",
  },
  {
    canonical: "gpt-daybreak-blue",
    families: ["daybreak-blue", "gpt-daybreak-blue"],
    label: "Daybreak Blue",
    colorKey: "daybreakBlue",
  },
  {
    canonical: "gpt-5.6-sol",
    families: ["sol", "gpt-5.6-sol"],
    label: "Sol",
    colorKey: "sol",
  },
  {
    canonical: "gpt-5.6-luna",
    families: ["luna", "gpt-5.6-luna"],
    label: "Luna",
    colorKey: "luna",
  },
  {
    canonical: "gpt-5.6-terra",
    families: ["terra", "gpt-5.6-terra"],
    label: "Terra",
    colorKey: "terra",
  },
  {
    canonical: "gpt-5.5-cyber",
    families: ["gpt-5.5-cyber"],
    label: "GPT-5.5 Cyber",
    colorKey: "gpt",
  },
  {
    canonical: "gpt-5.5",
    families: ["gpt-5.5"],
    label: "GPT-5.5",
    colorKey: "gpt",
  },
  {
    canonical: "gpt-5.4-mini",
    families: ["gpt-5.4-mini"],
    label: "GPT-5.4 Mini",
    colorKey: "gpt",
  },
  {
    canonical: "gpt-5.4",
    families: ["gpt-5.4"],
    label: "GPT-5.4",
    colorKey: "gpt",
  },
  {
    canonical: "gpt-5.3-codex",
    families: ["gpt-5.3-codex"],
    label: "GPT-5.3 Codex",
    colorKey: "gpt",
  },
  {
    canonical: "gpt-5.2",
    families: ["gpt-5.2"],
    label: "GPT-5.2",
    colorKey: "gpt",
  },
  {
    canonical: "gpt",
    families: ["gpt"],
    label: "GPT",
    colorKey: "gpt",
    exact: true,
  },
  {
    canonical: "unknown",
    families: ["unknown", "unknown-model"],
    label: "Unknown model",
    colorKey: "other",
    exact: true,
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
  return MODEL_PRESENTATIONS.find((presentation) => presentation.families.some(
    (family) => normalized === family || (
      presentation.exact !== true && normalized.startsWith(`${family}-`)
    ),
  ));
}

export function normalizeModelIdentifier(value) {
  const normalized = normalizedModel(value) || "unknown";
  return presentationFor(normalized)?.canonical || normalized;
}

export function modelDisplayName(value) {
  const model = String(value || "").trim();
  return presentationFor(model)?.label || model || "Unknown model";
}

export function modelColorKey(value) {
  return presentationFor(value)?.colorKey || "other";
}
