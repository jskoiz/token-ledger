# Token Ledger 0.4.1

## Model and cost accuracy

- Add purchased-credit and API price support for GPT-6.1 Sol, GPT-6 Astra,
  GPT-6 Sol, and GPT-6 Luna, with rates verified on September 29, 2026.
- Expand the API text-model rate card and apply the published Standard, Fast,
  Ultrafast, Flex, and Batch prices where supported.
- Correct purchased-credit Fast pricing to 2x Standard and Astra Ultrafast
  pricing to 6x. Included subscription limits remain separate.
- Apply cache-write prices and full-request long-context prices without
  counting cached input or reasoning tokens twice.
- Mark Standard-price assumptions when the recorded speed tier is missing,
  including the affected token count in cost reports.
- Keep Rosalind aggregates that cross the API billing start date explicitly
  unrated, including allocated fragments whose source aggregate crosses it.
- Preserve individual call models when a model changes within a turn, and
  rebuild old snapshot labels and credit estimates with the current rate card.
- Keep usage from models without published prices in token totals while
  reporting their cost as unrated.

## Dependencies

- Update Sharp to 0.35.5 and its bundled image libraries.
- Update the development dependency js-yaml to 4.3.2.

Requires Node.js 22.13 or newer. Token Ledger remains a local-only CLI.
