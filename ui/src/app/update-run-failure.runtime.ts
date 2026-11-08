import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "../../../src/infra/update-run-legacy-expiry.js";
import {
  isAcknowledgedAbandonedUpdateRun,
  type UpdateRunRecord,
} from "../../../src/infra/update-run-record.js";
import { renderUpdateRunReport } from "../../../src/infra/update-run-report.js";
import type { UpdateFailureTriage } from "./update-overlay-helpers.ts";

export function projectUpdateRunFailure(run: UpdateRunRecord): UpdateFailureTriage | null {
  if (
    isAcknowledgedAbandonedUpdateRun(run) ||
    (run.status !== "failed" && run.status !== "rolled-back")
  ) {
    return null;
  }
  const step = run.steps.findLast((entry) => entry.status === "failed");
  return {
    id: run.runId,
    reconciledRecord: { id: run.runId, timestampMs: run.finishedAtMs ?? run.updatedAtMs },
    outcome: "failed",
    banner: {
      tone: run.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON ? "warn" : "danger",
      text: renderUpdateRunReport(run).markdown,
    },
    attempt: {
      timestampMs: run.finishedAtMs ?? run.updatedAtMs,
      status: run.status,
      reason: run.reason ?? "unexpected-error",
      installKind: run.target.kind ?? null,
      beforeVersion: run.before.version ?? null,
      beforeSha: run.before.sha ?? null,
      afterVersion: run.after.version ?? null,
      afterSha: run.after.sha ?? null,
      failure: step ? { step: step.step, detail: step.detail ?? "" } : null,
    },
  };
}
