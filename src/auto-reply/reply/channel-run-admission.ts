import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { captureTaskOrigin } from "../../agents/task-origin.js";
import type { ExecutionIdentityAdmissionFacts } from "../../audit/execution-identity-admission.js";
import {
  consumeChannelAdmissionEvidence,
  recordChannelAdmissionDecision,
  type ChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue/types.js";

/** Adapt one opaque channel carrier to the canonical admitted-run facts and decision FIFO. */
export function consumeChannelRunAdmission(evidence: ChannelAdmissionEvidence | undefined): {
  ingressState: ExecutionIdentityAdmissionFacts["ingress"]["state"];
  facts: Pick<ExecutionIdentityAdmissionFacts, "invoker" | "assurance">;
  onAdmitted: (context: AdmittedRunContext) => void;
} {
  const admission = consumeChannelAdmissionEvidence(evidence);
  return Object.freeze({
    ingressState: admission.ingressState,
    facts: Object.freeze({
      invoker: admission.invoker,
      ...(admission.assuranceRef
        ? {
            assurance: [
              {
                kind: "channel-admission" as const,
                rawEvidenceRef: admission.assuranceRef,
                // Core verified the registered record/epoch/scope handoff; the
                // native plugin remains the remote participant-fact producer.
                strength: "boundary-verified" as const,
              },
            ],
          }
        : {}),
    }),
    onAdmitted: (context) => {
      const token = context.executionIdentityToken;
      if (token && admission.decisionCoverage && admission.identifierAuthentication) {
        recordChannelAdmissionDecision({
          contextId: token.contextId,
          executionId: token.executionId,
          runId: token.runId,
          occurredAt: token.createdAt,
          coverageState: admission.decisionCoverage,
          identifierAuthentication: admission.identifierAuthentication,
        });
      }
    },
  });
}

/** Defer evidence consumption until the selected runtime actually admits the run. */
export function prepareChannelRunAdmission(params: {
  cfg: OpenClawConfig;
  runId: string;
  agentId: string;
  ingressKind: ExecutionIdentityAdmissionFacts["ingress"]["kind"];
  boundary: string;
  evidence?: ChannelAdmissionEvidence;
  taskOrigin?: import("../../agents/task-origin.js").TaskOriginSnapshot;
  onAdmitted?: (context: AdmittedRunContext) => void;
}): PreparedAgentRunAdmission {
  const operationalRunInstance = createOperationalRunInstanceRef(params.runId);
  let prepared: PreparedAgentRunAdmission | undefined;
  let closed = false;
  return Object.freeze({
    operationalRunInstance,
    assertSourceCurrent: () => prepared?.assertSourceCurrent(),
    admit: (runtimeKind, runtimeInstanceId) => {
      if (closed) {
        return Promise.reject(new Error("prepared execution context is already closed"));
      }
      if (!prepared) {
        const channelAdmission = consumeChannelRunAdmission(params.evidence);
        prepared = prepareAgentRunAdmission({
          cfg: params.cfg,
          taskOrigin: params.taskOrigin,
          operationalRunInstance,
          facts: {
            runId: params.runId,
            agentId: params.agentId,
            ingress: {
              kind: params.ingressKind,
              boundary: params.boundary,
              state: channelAdmission.ingressState,
            },
            ...channelAdmission.facts,
          },
          onAdmitted: (context) => {
            channelAdmission.onAdmitted(context);
            params.onAdmitted?.(context);
          },
        });
      }
      return prepared.admit(runtimeKind, runtimeInstanceId);
    },
    close: () => {
      closed = true;
      prepared?.close();
    },
  });
}

/** The same exact source facts bind live admission and its durable recovery claim. */
export function captureChannelTaskOrigin(
  followupRun: FollowupRun,
  sourceRunId: string,
  sessionKey?: string,
  lifecycleGeneration?: string,
  sourceSessionId = followupRun.run.sessionId,
) {
  return captureTaskOrigin({
    inherited: followupRun.taskOrigin,
    external:
      !followupRun.run.inputProvenance || followupRun.run.inputProvenance.kind === "external_user",
    channel: followupRun.run.messageProvider,
    accountId: followupRun.run.agentAccountId,
    senderId: followupRun.run.senderId,
    sourceSessionKey: sessionKey,
    sourceSessionId,
    sourceRunId,
    sourceSessionLifecycleRevision: lifecycleGeneration,
    audience: followupRun.originatingTo,
    groupSpace: followupRun.run.groupSpace,
    threadId: followupRun.originatingThreadId,
  });
}
