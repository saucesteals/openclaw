import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import { hasMainSessionRecoveryClaim } from "../config/sessions/restart-recovery-state.js";
import type {
  HarnessCompletionRecovery,
  RestartRecoveryTerminalDeliveryEvidenceResult,
} from "../config/sessions/restart-recovery-types.js";
import {
  bindPreparedSessionSourceAssertion,
  prepareSessionSourceScope,
  releaseSessionSourceAuthorities,
} from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { isAgentMediatedCompletionSourceTool } from "../sessions/input-provenance.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
  getOwedHarnessCompletionTask,
} from "./agent-harness-completion-recovery.js";
import type { AgentCommandOpts } from "./command/types.js";
import {
  collectDeliveredMediaUrls,
  collectMessagingToolDeliveredMediaUrls,
  hasCommittedOutboundDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleAgentPayload,
  hasExplicitlyVisibleAgentPayload,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
  type AgentDeliveryEvidence,
} from "./embedded-agent-runner/delivery-evidence.js";
import { mergeAttemptToolMediaPayloads } from "./embedded-agent-runner/run/tool-media-payloads.js";

/** Restore the exact host-owned delivery constraints before starting a recovery turn. */
export function resolveCommandRecoveryOptions(params: {
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  runId: string;
}): AgentCommandOpts {
  const { sessionEntry: entry } = params;
  const media =
    entry?.restartRecoveryDeliveryRunId === params.runId &&
    Array.isArray(entry.restartRecoveryDeliveryMediaUrls)
      ? entry.restartRecoveryDeliveryMediaUrls
      : undefined;
  const originOptions =
    entry?.restartRecoveryDeliveryRunId === params.runId
      ? { ...params.opts, taskOrigin: entry.restartRecoveryTaskOrigin }
      : params.opts;
  const opts =
    media !== undefined
      ? {
          ...originOptions,
          internalDeliveryMediaUrls: [...media],
          internalDeliveryMediaSelected: entry?.restartRecoveryDeliveryMediaSelected === true,
          internalDeliverySuppressText: entry?.restartRecoverySuppressTextDelivery,
          sourceReplyDeliveryMode: entry?.restartRecoverySourceReplyDeliveryMode,
          disableMessageTool: entry?.restartRecoveryDisableMessageTool,
          forceRestartSafeTools: entry?.restartRecoveryForceSafeTools,
        }
      : originOptions;
  if (
    (opts.internalDeliverySuppressText === true && opts.internalDeliveryMediaUrls === undefined) ||
    ((opts.internalDeliveryMediaUrls !== undefined || opts.internalDeliverySuppressText === true) &&
      (opts.disableMessageTool !== true || opts.sourceReplyDeliveryMode !== "automatic"))
  ) {
    throw new Error(
      "internal delivery media constraints require automatic delivery and no message tool",
    );
  }
  return opts;
}

function normalizeOptionalThreadId(value: unknown): string | undefined {
  return (
    normalizeOptionalString(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)
  );
}

/** Preserve eligible fresh selection; recovery uses the exact host-owned delivery set. */
export function constrainRestartRecoveryDeliveryPayloads(
  payloads: ReplyPayload[] | undefined,
  mediaUrls: string[],
  suppressText = false,
  trustedLocalMedia = true,
  allowSelection = false,
): ReplyPayload[] {
  if (
    allowSelection &&
    collectDeliveredMediaUrls({
      payloads: payloads?.filter(
        (payload) => payload.isError !== true && hasExplicitlyVisibleAgentPayload(payload),
      ),
    }).length > 0
  ) {
    return (payloads ?? []).map((payload) =>
      payload.isError === true || !hasExplicitlyVisibleAgentPayload(payload)
        ? Object.assign({}, payload, {
            mediaUrl: undefined,
            mediaUrls: undefined,
            attachments: undefined,
          })
        : payload,
    );
  }
  const constrained: ReplyPayload[] = [];
  for (const payload of payloads ?? []) {
    const constrainedPayload: ReplyPayload = {};
    if (!suppressText && typeof payload.text === "string") {
      constrainedPayload.text = payload.text;
    }
    for (const flag of [
      "isError",
      "isReasoning",
      "isCommentary",
      "isReasoningSnapshot",
      "isCompactionNotice",
      "isFallbackNotice",
      "isStatusNotice",
    ] as const) {
      if (payload[flag] === true) {
        constrainedPayload[flag] = true;
      }
    }
    if (Object.keys(constrainedPayload).length > 0) {
      constrained.push(constrainedPayload);
    }
  }
  const exactMediaUrls = Array.from(
    new Set(mediaUrls.map((url) => url.trim()).filter((url) => url.length > 0)),
  );
  if (exactMediaUrls.length === 0) {
    return constrained;
  }

  if (!suppressText) {
    const visibleReplyIndex = constrained.findIndex((payload) =>
      hasVisibleAgentPayload(
        { payloads: [payload] },
        {
          includeErrorPayloads: false,
          includeSilentReplyPayloads: false,
          requireTerminalContent: true,
        },
      ),
    );
    const visibleReply = constrained[visibleReplyIndex];
    if (visibleReply) {
      // Recovery owns the exact artifacts; merge them with the actual final
      // reply so automatic delivery cannot emit a caption before its media.
      const [mergedReply] =
        mergeAttemptToolMediaPayloads({
          payloads: [visibleReply],
          toolMediaUrls: exactMediaUrls,
          hostOwnedToolMediaUrls: exactMediaUrls,
          toolTrustedLocalMedia: trustedLocalMedia,
          sourceReplyDeliveryMode: "automatic",
        }) ?? [];
      if (mergedReply) {
        constrained[visibleReplyIndex] = mergedReply;
        return constrained;
      }
    }
  }

  constrained.push({ mediaUrls: exactMediaUrls, trustedLocalMedia });
  return constrained;
}

/** Reduce a terminal result to bounded, route-checkable delivery evidence. */
export function buildRestartRecoveryTerminalDeliveryEvidence(
  result: AgentDeliveryEvidence,
): RestartRecoveryTerminalDeliveryEvidenceResult {
  const rawPayloads = Array.isArray(result.payloads) ? result.payloads : undefined;
  const payloads: RestartRecoveryTerminalDeliveryEvidenceResult["payloads"] = rawPayloads
    ?.slice(0, 64)
    .map((payload) => {
      const mediaUrls = collectDeliveredMediaUrls({ payloads: [payload] });
      const visible = hasVisibleAgentPayload(
        { payloads: [payload] },
        {
          requireTerminalContent: true,
          includeErrorPayloads: false,
          includeReasoningPayloads: false,
          includeSilentReplyPayloads: false,
        },
      );
      const evidence: { mediaUrls?: string[]; visible?: boolean } = { visible };
      if (mediaUrls.length > 0) {
        evidence.mediaUrls = mediaUrls;
      }
      return evidence;
    });
  const payloadsTruncated = rawPayloads && rawPayloads.length > 64 ? (true as const) : undefined;
  const rawDeliveryStatus = result.deliveryStatus;
  const status =
    rawDeliveryStatus?.status === "failed" ||
    rawDeliveryStatus?.status === "partial_failed" ||
    rawDeliveryStatus?.status === "sent" ||
    rawDeliveryStatus?.status === "suppressed"
      ? rawDeliveryStatus.status
      : undefined;
  const rawPayloadOutcomes =
    rawDeliveryStatus && typeof rawDeliveryStatus === "object"
      ? (rawDeliveryStatus as { payloadOutcomes?: unknown }).payloadOutcomes
      : undefined;
  const payloadOutcomes: NonNullable<
    RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"]
  >["payloadOutcomes"] = Array.isArray(rawPayloadOutcomes)
    ? rawPayloadOutcomes.flatMap((record) => {
        if (!isRecord(record)) {
          return [];
        }
        const outcomeStatus =
          record.status === "failed" || record.status === "sent" || record.status === "suppressed"
            ? record.status
            : undefined;
        if (!outcomeStatus || typeof record.index !== "number" || !Number.isInteger(record.index)) {
          return [];
        }
        return [
          {
            index: record.index,
            status: outcomeStatus,
            ...(typeof record.sentBeforeError === "boolean"
              ? { sentBeforeError: record.sentBeforeError }
              : {}),
          },
        ];
      })
    : undefined;
  const errorMessage = normalizeOptionalString(rawDeliveryStatus?.errorMessage);
  const deliveryStatus: RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"] = status
    ? {
        status,
        ...(typeof rawDeliveryStatus?.resultCount === "number" &&
        Number.isSafeInteger(rawDeliveryStatus.resultCount) &&
        rawDeliveryStatus.resultCount >= 0
          ? { resultCount: rawDeliveryStatus.resultCount }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(payloadOutcomes?.length ? { payloadOutcomes } : {}),
      }
    : undefined;
  const rawMessagingToolSentTargets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : undefined;
  const messagingToolSentTargets: RestartRecoveryTerminalDeliveryEvidenceResult["messagingToolSentTargets"] =
    rawMessagingToolSentTargets
      ? rawMessagingToolSentTargets.slice(0, 64).flatMap((record) => {
          if (!isRecord(record)) {
            return [];
          }
          const mediaUrls = collectMessagingToolDeliveredMediaUrls({
            messagingToolSentTargets: [record],
          });
          const visible = hasVisibleCommittedMessagingToolDeliveryEvidence({
            messagingToolSentTargets: [record],
          });
          const evidence: NonNullable<
            RestartRecoveryTerminalDeliveryEvidenceResult["messagingToolSentTargets"]
          >[number] = { visible };
          for (const key of ["provider", "accountId", "to"] as const) {
            const value = normalizeOptionalString(record[key]);
            if (value) {
              evidence[key] = value;
            }
          }
          const threadId = normalizeOptionalThreadId(record.threadId);
          if (threadId) {
            evidence.threadId = threadId;
          }
          if (record.threadImplicit === true) {
            evidence.threadImplicit = true;
          }
          if (record.threadSuppressed === true) {
            evidence.threadSuppressed = true;
          }
          if (typeof record.sourceReplyFinal === "boolean") {
            evidence.sourceReplyFinal = record.sourceReplyFinal;
          }
          if (mediaUrls.length > 0) {
            evidence.mediaUrls = mediaUrls;
          }
          return [evidence];
        })
      : undefined;
  const messagingToolSentTargetsTruncated =
    rawMessagingToolSentTargets && rawMessagingToolSentTargets.length > 64
      ? (true as const)
      : undefined;
  const messagingToolAggregateEvidenceUnaccounted = hasUnaccountedMessagingToolAggregateEvidence(
    result,
  )
    ? (true as const)
    : undefined;
  const restartUnsafeSideEffectsDetected =
    hasCommittedOutboundDeliveryEvidence(result) ||
    result.didSendDeterministicApprovalPrompt === true
      ? (true as const)
      : undefined;
  return {
    captured: true,
    ...(payloads?.length ? { payloads } : {}),
    ...(payloadsTruncated ? { payloadsTruncated } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(messagingToolSentTargets?.length ? { messagingToolSentTargets } : {}),
    ...(messagingToolSentTargetsTruncated ? { messagingToolSentTargetsTruncated } : {}),
    ...(messagingToolAggregateEvidenceUnaccounted
      ? { messagingToolAggregateEvidenceUnaccounted }
      : {}),
    ...(restartUnsafeSideEffectsDetected ? { restartUnsafeSideEffectsDetected } : {}),
  };
}

export function shouldPersistCurrentRunSessionCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
): boolean {
  if (!current || current.sessionId !== sessionId) {
    return false;
  }
  if (current.abortedLastRun !== true) {
    return true;
  }
  // Stop is terminal, while a restart keeps custody. Only the settled command
  // may retire its own source claim after all execution and delivery owners leave.
  return (
    current.status === "killed" &&
    current.lastRunId === runId &&
    current.restartRecoveryDeliveryRunId === runId &&
    current.lifecycleRunId === undefined &&
    !current.mainRestartRecovery &&
    !current.restartRecoveryRuns?.length &&
    !current.pendingFinalDelivery
  );
}

export function shouldPersistRestartRecoveryContextClaim(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
  allowCreate: boolean,
): boolean {
  if (!current) {
    return allowCreate;
  }
  if (
    current.sessionId !== sessionId ||
    (current.abortedLastRun === true && hasMainSessionRecoveryClaim(current))
  ) {
    return false;
  }
  return (
    current.restartRecoveryDeliveryRunId === undefined ||
    current.restartRecoveryDeliveryRunId === runId
  );
}

export function buildCurrentRunRestartRecoveryClaim(params: {
  harnessCompletion?: HarnessCompletionRecovery;
  deliveryContext?: DeliveryContext;
  deliveryMediaUrls?: string[];
  disableMessageTool?: boolean;
  entry: SessionEntry;
  forceRestartSafeTools?: boolean;
  taskOrigin?: SessionEntry["restartRecoveryTaskOrigin"];
  runId: string;
  operatorSource?: SessionEntry["restartRecoveryOperatorSource"];
  sourceIngress?: SessionEntry["restartRecoverySourceIngress"];
  sourceRunId?: string;
  sourceReplyDeliveryMode?: SessionEntry["restartRecoverySourceReplyDeliveryMode"];
  suppressTextDelivery?: boolean;
}): Pick<
  SessionEntry,
  | "restartRecoveryDeliveryContext"
  | "restartRecoveryDeliveryMediaUrls"
  | "restartRecoveryDeliveryMediaSelected"
  | "restartRecoveryDisableMessageTool"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
  | "restartRecoveryHarnessCompletion"
  | "restartRecoveryForceSafeTools"
  | "restartRecoveryOperatorSource"
  | "restartRecoveryTaskOrigin"
  | "restartRecoverySourceIngress"
  | "restartRecoverySourceReplyDeliveryMode"
  | "restartRecoverySuppressTextDelivery"
> {
  // Recovery can preclaim a run by id. Preserve its original source semantics
  // while the resumed RPC replaces only the active delivery run id.
  const bindsAdmittedHarnessSource =
    params.harnessCompletion?.sourceRunId === params.runId &&
    params.entry.restartRecoveryDeliverySourceRunId === undefined;
  const adoptsExistingClaim =
    params.entry.restartRecoveryDeliveryRunId === params.runId && !bindsAdmittedHarnessSource;
  if (adoptsExistingClaim) {
    const entry = params.entry;
    return {
      ...(entry.restartRecoveryHarnessCompletion
        ? { restartRecoveryHarnessCompletion: entry.restartRecoveryHarnessCompletion }
        : {}),
      restartRecoveryDeliveryContext: entry.restartRecoveryDeliveryContext,
      restartRecoveryDeliveryMediaUrls: entry.restartRecoveryDeliveryMediaUrls,
      restartRecoveryDeliveryMediaSelected: entry.restartRecoveryDeliveryMediaSelected,
      restartRecoveryDisableMessageTool: entry.restartRecoveryDisableMessageTool,
      restartRecoverySuppressTextDelivery: entry.restartRecoverySuppressTextDelivery,
      restartRecoveryDeliveryRunId: params.runId,
      restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryOperatorSource: entry.restartRecoveryOperatorSource,
      restartRecoveryTaskOrigin: entry.restartRecoveryTaskOrigin,
      restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
      restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
      restartRecoveryForceSafeTools: entry.restartRecoveryForceSafeTools,
    };
  }
  const createsScopedDeliveryClaim = params.sourceRunId !== undefined;
  if (createsScopedDeliveryClaim && !params.sourceIngress) {
    throw new Error("restart recovery source ownership is required for a new claim");
  }
  return {
    ...(params.harnessCompletion
      ? { restartRecoveryHarnessCompletion: params.harnessCompletion }
      : params.entry.restartRecoveryHarnessCompletion
        ? { restartRecoveryHarnessCompletion: undefined }
        : {}),
    restartRecoveryDeliveryContext: params.deliveryContext,
    restartRecoveryDeliveryMediaUrls:
      createsScopedDeliveryClaim && params.deliveryMediaUrls !== undefined
        ? [...params.deliveryMediaUrls]
        : undefined,
    restartRecoveryDeliveryMediaSelected: undefined,
    restartRecoveryDisableMessageTool:
      createsScopedDeliveryClaim && params.disableMessageTool === true ? true : undefined,
    restartRecoverySuppressTextDelivery:
      createsScopedDeliveryClaim && params.suppressTextDelivery === true ? true : undefined,
    restartRecoveryDeliveryRunId: createsScopedDeliveryClaim ? params.runId : undefined,
    restartRecoveryDeliverySourceRunId: params.sourceRunId,
    restartRecoveryTaskOrigin: params.taskOrigin,
    restartRecoveryOperatorSource: createsScopedDeliveryClaim ? params.operatorSource : undefined,
    restartRecoverySourceIngress: createsScopedDeliveryClaim ? params.sourceIngress : undefined,
    restartRecoverySourceReplyDeliveryMode: params.sourceRunId
      ? params.sourceReplyDeliveryMode
      : undefined,
    restartRecoveryForceSafeTools:
      createsScopedDeliveryClaim && params.forceRestartSafeTools === true ? true : undefined,
  };
}

/** Prepare only an admitted channel completion, or the exact saved recovery claim. */
export function prepareCommandHarnessCompletionRecovery(params: {
  entry: SessionEntry;
  sessionId: string;
  sessionKey: string;
  runId: string;
  agentId: string;
  opts: AgentCommandOpts;
  hasDeliveryContext: boolean;
}) {
  const { entry, sessionId, sessionKey, runId, agentId, opts } = params;
  const harnessCompletion = params.hasDeliveryContext
    ? captureHarnessCompletionRecovery({
        agentId,
        sessionKey,
        entry: { ...entry, sessionId },
        runId,
        inputProvenance: opts.inputProvenance,
      })
    : undefined;
  const generatedMediaSourceRunId =
    opts.internalDeliveryMediaUrls !== undefined &&
    opts.inputProvenance?.kind === "inter_session" &&
    isAgentMediatedCompletionSourceTool(opts.inputProvenance.sourceTool)
      ? runId
      : undefined;
  const claimedHarnessCompletion =
    entry.restartRecoveryDeliveryRunId === runId
      ? entry.restartRecoveryHarnessCompletion
      : undefined;
  const guardedHarnessCompletion = harnessCompletion ?? claimedHarnessCompletion;
  if (guardedHarnessCompletion && !getOwedHarnessCompletionTask(guardedHarnessCompletion, entry)) {
    throw createSessionWorkStartChangedError(sessionKey);
  }
  return {
    harnessCompletion,
    guardedHarnessCompletion,
    isCompletionCurrent: (current: SessionEntry | undefined) =>
      !guardedHarnessCompletion ||
      Boolean(current && getOwedHarnessCompletionTask(guardedHarnessCompletion, current)),
    sourceOptions: {
      sourceIngress:
        generatedMediaSourceRunId || harnessCompletion ? ("internal" as const) : undefined,
      sourceRunId: generatedMediaSourceRunId ?? harnessCompletion?.sourceRunId,
      sourceReplyDeliveryMode:
        opts.sourceReplyDeliveryMode ?? (harnessCompletion ? ("automatic" as const) : undefined),
    },
  };
}

/** Called after the caller has recorded the committed entry for failure cleanup. */
export async function bindCommandHarnessCompletionAssertion(params: {
  claim?: HarnessCompletionRecovery;
  persisted?: SessionEntry;
  sessionKey: string;
  storePath?: string;
  opts: AgentCommandOpts;
}): Promise<{ opts: AgentCommandOpts; source?: { release(): Promise<void> } }> {
  const { claim, persisted, sessionKey, storePath, opts } = params;
  if (
    claim &&
    (!persisted ||
      persisted.restartRecoveryHarnessCompletion?.taskId !== claim.taskId ||
      !getOwedHarnessCompletionTask(claim, persisted))
  ) {
    throw createSessionWorkStartChangedError(sessionKey);
  }
  if (!claim || !storePath) {
    return { opts };
  }
  const guarded = {
    ...opts,
    assertSourceCurrent: Object.assign(
      createHarnessCompletionSourceAssertion({
        claim,
        storePath,
        priorAssertion: opts.assertSourceCurrent,
      }),
      { recoveryReference: opts.assertSourceCurrent?.recoveryReference },
    ),
  };
  // A resumed run needs its exact source prepared before the first assertion.
  const prepared = await prepareSessionSourceScope(guarded.assertSourceCurrent);
  if (!prepared) {
    guarded.assertSourceCurrent();
    return { opts: guarded };
  }
  const source = bindPreparedSessionSourceAssertion(guarded.assertSourceCurrent, prepared);
  try {
    source();
    return {
      opts: {
        ...guarded,
        assertSourceCurrent: Object.assign(source, {
          recoveryReference: guarded.assertSourceCurrent.recoveryReference,
        }),
      },
      source,
    };
  } catch (error) {
    await releaseSessionSourceAuthorities([source], [error]);
    throw error;
  }
}

/** Freeze normalized media under the active recovery claim before transport starts. */
export async function freezeCurrentRunDeliveryMedia(params: {
  agentId: string;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath: string;
  sessionId: string;
  runId: string;
  mediaUrls: string[];
  assertCurrent: () => void;
}): Promise<SessionEntry> {
  const { sessionStore, sessionKey, mediaUrls, runId } = params;
  const current = sessionKey ? sessionStore?.[sessionKey] : undefined;
  if (
    !sessionStore ||
    !sessionKey ||
    !current ||
    (!mediaUrls.length && current.restartRecoveryDeliveryMediaSelected !== true) ||
    mediaUrls.length > 64
  ) {
    throw new Error("generated-media selection requires its active recovery owner and media");
  }
  // Recovery may remove already-receipted payloads from this send. Never narrow
  // the canonical selection to that per-send subset.
  const selection =
    current.restartRecoveryDeliveryMediaSelected === true
      ? (current.restartRecoveryDeliveryMediaUrls ?? [])
      : mediaUrls;
  if (mediaUrls.some((url) => !selection.includes(url))) {
    throw new Error("generated-media retry changed its frozen selection");
  }
  const { persistAgentSession } = await import("./command/attempt-execution.shared.js");
  let authorized = false;
  const persisted = await persistAgentSession({
    agentId: params.agentId,
    sessionStore,
    sessionKey,
    storePath: params.storePath,
    initialEntry: current,
    entry: {
      ...current,
      restartRecoveryDeliveryMediaUrls: [...selection],
      restartRecoveryDeliveryMediaSelected: true,
    },
    shouldPersist: (fresh) => {
      params.assertCurrent();
      authorized =
        fresh?.sessionId === params.sessionId &&
        fresh.restartRecoveryDeliveryRunId === runId &&
        fresh.lifecycleRevision === current.lifecycleRevision &&
        (fresh.restartRecoveryDeliveryMediaSelected !== true ||
          isDeepStrictEqual(fresh.restartRecoveryDeliveryMediaUrls, selection));
      return authorized;
    },
  });
  if (
    !authorized ||
    persisted?.restartRecoveryDeliveryRunId !== runId ||
    persisted.restartRecoveryDeliveryMediaSelected !== true ||
    !isDeepStrictEqual(persisted.restartRecoveryDeliveryMediaUrls, selection)
  ) {
    throw new Error("generated-media selection lost its recovery owner");
  }
  return persisted;
}
