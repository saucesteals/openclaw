import {
  collectAutomaticDeliveredMediaUrls,
  collectDeliveredMediaUrls,
  hasCommittedOutboundDeliveryEvidence,
  hasExplicitlyVisibleAgentPayload,
  type AgentDeliveryEvidence,
} from "../agents/embedded-agent-runner/delivery-evidence.js";
import type { SessionDeliveryRoute } from "../infra/session-delivery-queue.records.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

function hasQueuedVisibleAgentPayload(result: Pick<AgentDeliveryEvidence, "payloads">): boolean {
  return Array.isArray(result.payloads) && result.payloads.some(hasExplicitlyVisibleAgentPayload);
}

export function hasUnexpectedRecoverySideEffects(result: AgentDeliveryEvidence): boolean {
  return (
    result.restartUnsafeSideEffectsDetected === true ||
    result.messagingToolAggregateEvidenceUnaccounted === true ||
    result.messagingToolSentTargetsTruncated === true ||
    result.didSendDeterministicApprovalPrompt === true ||
    hasCommittedOutboundDeliveryEvidence(result)
  );
}

function collectVisiblePayloadMediaUrls(result: AgentDeliveryEvidence): string[] {
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  return collectDeliveredMediaUrls({ payloads: payloads.filter(hasExplicitlyVisibleAgentPayload) });
}

export function collectQueuedDeliveredMediaUrls(params: {
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}): string[] {
  if (params.route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return collectVisiblePayloadMediaUrls(params.result);
  }
  return collectAutomaticDeliveredMediaUrls(params.result);
}

function hasAutomaticVisibleSendEvidence(result: AgentDeliveryEvidence): boolean {
  if (result.deliveryStatus?.status === "sent" || result.deliveryStatus?.status === "suppressed") {
    return hasQueuedVisibleAgentPayload(result);
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const outcomes = Array.isArray(result.deliveryStatus?.payloadOutcomes)
    ? result.deliveryStatus.payloadOutcomes
    : [];
  return outcomes.some((outcome) => {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      return false;
    }
    const record = outcome as Record<string, unknown>;
    if (
      record.status !== "sent" &&
      record.status !== "suppressed" &&
      record.sentBeforeError !== true
    ) {
      return false;
    }
    const index =
      typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
    return index !== undefined && hasExplicitlyVisibleAgentPayload(payloads[index]);
  });
}

export function hasQueuedVisibleReplyEvidence(params: {
  result: AgentDeliveryEvidence;
  route: SessionDeliveryRoute;
}): boolean {
  if (params.route.channel === INTERNAL_MESSAGE_CHANNEL) {
    return hasQueuedVisibleAgentPayload(params.result);
  }
  return hasAutomaticVisibleSendEvidence(params.result);
}
