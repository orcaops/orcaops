import { type BlockDispositionOptions, recordDatabaseBlockDisposition } from './database.js';
import { runCapture } from '../../lib/run-capture.js';

export type BlockAcknowledgeOptions = BlockDispositionOptions;

export async function blockAcknowledgeAction(opts: BlockAcknowledgeOptions): Promise<void> {
  await runCapture(() => recordDatabaseBlockDisposition('acknowledge', opts));
}
