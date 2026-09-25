import type { InterpretationProgress } from './knowledge-interpretation.js';
import type { InterpretationQuality } from '../../schema/knowledge-processing-contract.js';

type Counts = InterpretationQuality['proposed'];

export interface ProcessingExtractionSummary {
  sampledJobs: number;
  omittedJobs: number;
  notStartedJobs: number;
  unreadableJobs: number;
  scheduledUnits: number;
  settledUnits: number;
  outcomes: Record<InterpretationQuality['outcome'], number>;
  items: { proposed: Counts; accepted: Counts; heldBack: Counts; rejected: Counts };
  diagnosticsTotal: number;
  scheduledFieldOmissions: number;
  fields: {
    jobId: string;
    eventId: string;
    fieldPath: string;
    role: string;
    preparedRange: { start: number; end: number };
    settled: boolean;
  }[];
  omittedFieldDetails: number;
  omissions: { jobId: string; fieldPath: string; reason: string }[];
  omittedOmissionDetails: number;
}

export interface ProcessingExtractionJob {
  jobId: string;
  progress: InterpretationProgress | null;
  unreadable: boolean;
}

const counts = (): Counts => ({
  statements: 0,
  corrections: 0,
  links: 0,
  uncertainties: 0,
  alternatives: 0,
});

export function summarizeProcessingExtraction(
  jobs: readonly ProcessingExtractionJob[],
  omittedJobs: number
): ProcessingExtractionSummary {
  const summary: ProcessingExtractionSummary = {
    sampledJobs: jobs.length,
    omittedJobs,
    notStartedJobs: 0,
    unreadableJobs: 0,
    scheduledUnits: 0,
    settledUnits: 0,
    outcomes: { accepted: 0, partial: 0, all_rejected: 0, empty: 0 },
    items: { proposed: counts(), accepted: counts(), heldBack: counts(), rejected: counts() },
    diagnosticsTotal: 0,
    scheduledFieldOmissions: 0,
    fields: [],
    omittedFieldDetails: 0,
    omissions: [],
    omittedOmissionDetails: 0,
  };
  let detailBytes = 0;
  const fits = (value: unknown) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (detailBytes + bytes > 65_536) return false;
    detailBytes += bytes;
    return true;
  };
  for (const { jobId, progress, unreadable } of jobs) {
    if (unreadable) {
      summary.unreadableJobs += 1;
      continue;
    }
    if (progress === null) {
      summary.notStartedJobs += 1;
      continue;
    }
    const { schedule, receipts } = progress;
    summary.scheduledUnits += schedule.units.length;
    summary.settledUnits += receipts.length;
    summary.scheduledFieldOmissions += schedule.omissions_total;
    summary.omittedOmissionDetails += schedule.omissions_total - schedule.omissions.length;
    const completed = new Set(receipts.map((receipt) => receipt.unit_id));
    for (const unit of schedule.units) {
      for (const segment of unit.segments) {
        if (segment.purpose !== 'primary') continue;
        const field = {
          jobId,
          eventId: schedule.source_event_id,
          fieldPath: segment.occurrence.field_path,
          role: segment.role,
          preparedRange: segment.prepared_range,
          settled: completed.has(unit.unit_id),
        };
        if (summary.fields.length < 128 && fits(field)) summary.fields.push(field);
        else summary.omittedFieldDetails += 1;
      }
    }
    for (const omission of schedule.omissions) {
      const item = { jobId, fieldPath: omission.field_path, reason: omission.reason };
      if (summary.omissions.length < 128 && fits(item)) summary.omissions.push(item);
      else summary.omittedOmissionDetails += 1;
    }
    for (const { quality } of receipts) {
      summary.outcomes[quality.outcome] += 1;
      summary.diagnosticsTotal += quality.diagnostics_total;
      for (const key of [
        'statements',
        'corrections',
        'links',
        'uncertainties',
        'alternatives',
      ] as const) {
        summary.items.proposed[key] =
          (summary.items.proposed[key] ?? 0) + (quality.proposed[key] ?? 0);
        summary.items.accepted[key] =
          (summary.items.accepted[key] ?? 0) + (quality.accepted[key] ?? 0);
        summary.items.heldBack[key] =
          (summary.items.heldBack[key] ?? 0) + (quality.held_back[key] ?? 0);
        summary.items.rejected[key] =
          (summary.items.rejected[key] ?? 0) + (quality.rejected[key] ?? 0);
      }
    }
  }
  return summary;
}
