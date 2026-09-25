import { userInfo } from 'node:os';

import type { ProcessingAttributionBasis } from '@orcaops/storage/history/database';

import { getInvocationEnv, getInvocationInvokedByAgent } from './invocation-context.js';
import { resolveInvokingAgent } from './invoking-agent.js';

export interface ProcessingActor {
  changedBy: string | null;
  changedByBasis: ProcessingAttributionBasis;
}

/**
 * Who a local pause, resume or retry is attributed to, from what this command
 * line actually knows.
 *
 * The name is the operating-system account the process runs as. Nothing
 * verified it: a local invocation carries no authentication, so the basis is
 * never `authenticated`, whatever credentials happen to sit on this machine for
 * some other surface. When a coding agent invoked us — by its own flag or by
 * the environment it sets — the basis says the act was reported by an agent on
 * a person's instruction, which is the strongest claim the record can honestly
 * carry. An account name that cannot be read at all is nobody in particular,
 * and the store requires an unnamed actor to say exactly that.
 */
export function processingActor(): ProcessingActor {
  const env = getInvocationEnv();
  const name = accountName(env);
  if (name === null) return { changedBy: null, changedByBasis: 'unknown' };
  const invoking = resolveInvokingAgent({ flag: getInvocationInvokedByAgent(), env });
  return {
    changedBy: name,
    changedByBasis:
      invoking.source === 'flag' || invoking.source === 'env'
        ? 'agent_reported_user_instruction'
        : 'other_assertion',
  };
}

function accountName(env: NodeJS.ProcessEnv): string | null {
  try {
    const name = userInfo().username.trim();
    if (name) return name;
  } catch {
    // An account the process cannot describe is not a name to record.
  }
  const fallback = (env.USER ?? env.USERNAME ?? '').trim();
  return fallback === '' ? null : fallback;
}
