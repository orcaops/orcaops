/**
 * The three versions a grant, an attempt and a job identity are pinned to.
 *
 * PROCESSOR_CONTRACT is the one definition beside the processing configuration,
 * re-exported here, so a grant and a job can never name two different contracts.
 * A workload grant names the PROCESSOR_CONTRACT, so changing it invalidates
 * every grant recorded against the old one: a new contract is a new job
 * identity, and history already processed under the old one is neither
 * reprocessed nor reinterpreted. The other two move underneath a grant,
 * because neither widens what is sent or what may be published: PROMPT_VERSION
 * changes the wording the model is given, and PROPOSAL_SCHEMA_VERSION changes
 * the shape it must answer in. Both are retained with the attempt so a later
 * reader can tell which wording and which shape produced a record.
 */
export { PROCESSING_PROCESSOR_CONTRACT as PROCESSOR_CONTRACT } from '../processing-contract.js';
export const PROMPT_VERSION = 'knowledge-interpretation-prompt@8';
export const PROPOSAL_SCHEMA_VERSION = 'knowledge-proposal@7';

/** What everything this contract publishes is attributed to. Never an actor. */
export const INTERPRETATION_DETECTOR = 'knowledge-interpretation';
