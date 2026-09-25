/**
 * The processor a consent grant covers and a processing job is admitted under.
 * It lives here, beside the interpretation contract that will define what is
 * sent and what is published, so a grant and a job can never name two
 * different contracts. Changing what the processor sends or asks for means a
 * new value here and a new grant: a job prepared under a different contract is
 * refused rather than sent.
 */
export const PROCESSING_PROCESSOR_CONTRACT = 'knowledge-interpretation@2';
