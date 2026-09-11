export function writeReviewOutput(bytes: string): void {
  process.stdout.write(bytes);
}

export function writeReviewError(bytes: string): void {
  process.stderr.write(bytes);
}
