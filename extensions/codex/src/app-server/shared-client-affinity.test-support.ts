import { expect, it, vi } from "vitest";
import {
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

/** Reuse the shared-client suite's auth fixtures and initialization protocol. */
export function registerSharedClientAffinityTests(
  rejectAuth: (error: Error) => void,
  sendInitializeResult: (
    harness: ReturnType<typeof createClientHarness>,
    userAgent: string,
  ) => Promise<void>,
) {
  it.each(["same", "auth-changed", "claimed", "artifact", "auth-failed"] as const)(
    "qualifies only the exact retired background owner: %s",
    async (mode) => {
      const ownerHarness = createClientHarness();
      const successorHarness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(ownerHarness.client)
        .mockResolvedValueOnce(successorHarness.client);
      const acquiring = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
      await sendInitializeResult(ownerHarness, "openclaw/0.151.0 (Linux; test)");
      const owner = await acquiring;
      const backgroundLeases = Array.from({ length: 3 }, () =>
        retainSharedCodexAppServerClientIfCurrent(owner)!,
      );
      const protections = Array.from({ length: 3 }, () =>
        protectCodexAppServerLiveThread(owner, "parent"),
      );
      await retainCodexAppServerLiveThread(owner, "parent", async () => {});
      if (mode === "claimed") {
        await consumeCodexAppServerLiveThread(owner, "parent");
      }
      releaseLeasedSharedCodexAppServerClient(owner);
      retireSharedCodexAppServerClientIfCurrent(owner);
      if (mode === "auth-failed") {
        rejectAuth(new Error("current auth refused"));
      }
      const next = getLeasedSharedCodexAppServerClient({
        timeoutMs: 1000,
        ...(mode === "auth-changed" ? { authBindingFingerprint: "different-account" } : {}),
        ...(mode === "artifact" ? { runtimeArtifactMode: "capture" as const } : {}),
        boundThread: { clientId: owner.getInstanceId(), threadId: "parent" },
      });
      try {
        if (mode === "auth-failed" || mode === "artifact") {
          await expect(next).rejects.toThrow(
            mode === "auth-failed" ? "current auth refused" : "must be resolved before spawn",
          );
          expect(ownerHarness.stdinDestroyed).toBe(false);
          return;
        }
        if (mode !== "same") {
          await sendInitializeResult(successorHarness, "openclaw/0.151.0 (Linux; test)");
        }
        const selected = await next;
        expect(selected).toBe(mode === "same" ? owner : successorHarness.client);
        expect(ownerHarness.stdinDestroyed).toBe(false);
        releaseLeasedSharedCodexAppServerClient(selected);
        if (mode === "same") {
          // Exact-thread continuation must not revive this retired client for
          // unrelated sessions, even though its background commands remain live.
          const ordinary = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
          await sendInitializeResult(successorHarness, "openclaw/0.151.0 (Linux; test)");
          expect(await ordinary).toBe(successorHarness.client);
          releaseLeasedSharedCodexAppServerClient(successorHarness.client);
        }
      } finally {
        protections.forEach((release) => release());
        backgroundLeases.forEach((release) => release());
      }
    },
  );
}
