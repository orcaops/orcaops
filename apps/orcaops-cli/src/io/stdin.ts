/**
 * Read all of stdin to EOF as a UTF-8 string. Lifted out of `io/input.ts` (the
 * YAML/JSON capture-payload reader) so the raw-body reader (`io/body-input.ts`,
 * used by `plan review propose/push/comment`) shares the one stdin drain instead
 * of duplicating it.
 */
export async function readAllStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}
