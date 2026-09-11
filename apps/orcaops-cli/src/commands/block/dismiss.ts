import { type BlockDispositionOptions, recordDatabaseBlockDisposition } from './database.js';
import { runCapture } from '../../lib/run-capture.js';

export type BlockDismissOptions = BlockDispositionOptions;

export async function blockDismissAction(opts: BlockDismissOptions): Promise<void> {
  await runCapture(() => recordDatabaseBlockDisposition('dismiss', opts));
}
