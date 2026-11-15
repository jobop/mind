// Accept common copy formats without ever exposing the credential in logs.
export function platformE2BKey(value) {
  let key = String(value || '').trim();
  key = key.replace(/^(?:export\s+)?E2B_API_KEY\s*=\s*/, '').trim();
  if (key.length > 1 && ['"', "'", '`'].includes(key[0]) && key.at(-1) === key[0]) key = key.slice(1, -1).trim();
  return key;
}
