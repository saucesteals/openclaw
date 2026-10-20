import type { CliDeps } from "../../cli/deps.types.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { AgentRunSessionTarget } from "../run-session-target.types.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { runEmbeddedAgentAttempt } from "./run-embedded-attempt.js";
import type { EmbeddedSessionState } from "./session-preparation.js";
import type { AgentCommandOpts } from "./types.js";

type EmbeddedAgentAttempt = Awaited<ReturnType<typeof runEmbeddedAgentAttempt>>;

export type FinalizeEmbeddedAgentCommandParams = {
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  deps: CliDeps;
  runtime: RuntimeEnv;
  sessionEntry?: SessionEntry;
  attempt: EmbeddedAgentAttempt;
  embeddedSessionState: EmbeddedSessionState;
  suppressVisibleSessionEffects: boolean;
  preserveUserFacingSessionModelState: boolean;
  currentRunDeliveryContext?: DeliveryContext;
  sessionOwnership: {
    runOwnedSessionId: string;
    sessionReboundDuringRun: boolean;
  };
  trackInternalModelRunTarget: (target: AgentRunSessionTarget | undefined) => void;
  onSessionOwnershipChanged: (
    ownership: { runOwnedSessionId: string; sessionReboundDuringRun: boolean },
    committedCompactionSessionId?: string,
  ) => void;
  onTerminalDeliveryEvidenceChanged: (
    evidence: RestartRecoveryTerminalDeliveryEvidenceResult,
  ) => void;
};
