import { onTestFinished, vi } from "vitest";
import type { ChannelStreamingProgressConfig } from "../config/types.base.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import type { ChannelProgressDraftCompositorParams } from "./progress-draft-compositor.types.js";

export function createProgress(
  config: ChannelStreamingProgressConfig = { label: "Shelling", toolProgress: true },
  overrides: Partial<ChannelProgressDraftCompositorParams> = {},
) {
  const update = vi.fn<NonNullable<ChannelProgressDraftCompositorParams["update"]>>();
  const progress = createChannelProgressDraftCompositor({
    active: true,
    mode: "progress",
    seed: "test",
    entry: { streaming: { mode: overrides.mode ?? "progress", progress: config } },
    update,
    ...overrides,
  });
  onTestFinished(() => progress.cancel());
  return { progress, update };
}

export const plan = [
  { step: "Inspect", status: "completed" },
  { step: "Repair", status: "in_progress" },
  { step: "Verify", status: "pending" },
] satisfies Parameters<
  ReturnType<typeof createChannelProgressDraftCompositor>["pushPlanProgress"]
>[0];
