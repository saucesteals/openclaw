import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";

/** Host-prepared source routing facts used to construct a Gateway tool caller. */
export type GatewayToolCallerSource = {
  agentSessionKey?: string;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
};
