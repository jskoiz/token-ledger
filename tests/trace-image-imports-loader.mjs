const IMAGE_GRAPH = /sharp|token-ledger-(?:trend|cache)-image/;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (IMAGE_GRAPH.test(specifier) || IMAGE_GRAPH.test(result.url)) {
    process.stderr.write(`TOKEN_LEDGER_IMAGE_GRAPH ${result.url}\n`);
  }
  return result;
}
