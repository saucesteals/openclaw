import { describe, expect, it } from "vitest";
import { freezeCurrentRunDeliveryMedia } from "../../agents/agent-command-restart-recovery.js";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
} from "./restart-recovery-receipt.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  getRestartRecoveryTerminalDeliveryEvidence,
} from "./restart-recovery-state.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("restart recovery terminal delivery receipt", () => {
  const fixture = useTempSessionsFixture("restart-receipt-");
  const sessionKey = "agent:main:discord:direct:123";

  async function seedClaim(params?: { sessionId?: string; sourceTurnId?: string }) {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: params?.sessionId ?? "session-1",
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: params?.sourceTurnId ?? "source-1",
        updatedAt: 1,
      },
    );
  }

  function scope(params?: { sessionId?: string; sourceTurnId?: string }) {
    return {
      sessionId: params?.sessionId ?? "session-1",
      sessionKey,
      sourceTurnId: params?.sourceTurnId ?? "source-1",
      storePath: fixture.storePath(),
      toolCallId: "message-call-1",
    };
  }

  it("freezes under real ownership, keeps the whole set for subset sends, and refuses a stale lifecycle", async () => {
    await seedClaim();
    const storePath = fixture.storePath();
    const current = loadSessionEntry({ sessionKey, storePath })!;
    const sessionStore = { [sessionKey]: current };
    const base = {
      sessionStore,
      sessionKey,
      storePath,
      sessionId: "session-1",
      runId: "recovery-1",
      assertCurrent: () => {},
    };
    const frozen = await freezeCurrentRunDeliveryMedia({
      ...base,
      mediaUrls: ["/tmp/a.gif", "/tmp/b.gif"],
    });
    expect(frozen.restartRecoveryDeliveryMediaUrls).toEqual(["/tmp/a.gif", "/tmp/b.gif"]);
    const subset = await freezeCurrentRunDeliveryMedia({ ...base, mediaUrls: ["/tmp/b.gif"] });
    expect(subset.restartRecoveryDeliveryMediaUrls).toEqual(["/tmp/a.gif", "/tmp/b.gif"]);
    const receipted = await freezeCurrentRunDeliveryMedia({ ...base, mediaUrls: [] });
    expect(receipted.restartRecoveryDeliveryMediaUrls).toEqual(["/tmp/a.gif", "/tmp/b.gif"]);
    await expect(
      freezeCurrentRunDeliveryMedia({ ...base, mediaUrls: ["/tmp/new.gif"] }),
    ).rejects.toThrow("changed its frozen selection");
    await replaceSessionEntry(
      { sessionKey, storePath },
      { ...subset, lifecycleRevision: "rotated" },
    );
    await expect(
      freezeCurrentRunDeliveryMedia({ ...base, mediaUrls: ["/tmp/b.gif"] }),
    ).rejects.toThrow("lost its recovery owner");
    expect(loadSessionEntry({ sessionKey, storePath })?.lifecycleRevision).toBe("rotated");
  });

  it("retains the frozen selection through terminal cleanup and persisted reopen", async () => {
    await seedClaim();
    const entry = loadSessionEntry({ sessionKey, storePath: fixture.storePath() })!;
    const selected = {
      ...entry,
      restartRecoveryDeliveryMediaUrls: ["/tmp/final.gif"],
      restartRecoveryDeliveryMediaSelected: true as const,
    };
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        ...selected,
        ...buildRestartRecoveryClaimCleanupPatch({
          entry: selected,
          recordTerminalSource: true,
          terminalRunId: "recovery-1",
          terminalDeliveryEvidence: {
            captured: true,
            payloads: [{ mediaUrls: ["/tmp/final.gif"], visible: true }],
            deliveryStatus: { status: "failed" },
          },
        }),
      },
    );
    const reopened = loadSessionEntry({ sessionKey, storePath: fixture.storePath() });
    expect(reopened?.restartRecoveryDeliveryMediaSelected).toBeUndefined();
    expect(getRestartRecoveryTerminalDeliveryEvidence(reopened, "source-1")).toMatchObject({
      selectedMediaUrls: ["/tmp/final.gif"],
      deliveryStatus: { status: "failed" },
    });
  });

  it("persists pending before delivery and completion after provider success", async () => {
    await seedClaim();

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("terminal-pending");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBe("message-call-1");

    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("delivered-terminal");
  });

  it("blocks a repeated terminal send while its outcome is already durable", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("delivery-ambiguous");
  });

  it.each([undefined, "done" as const])(
    "does not arm a receipt for a live claimless turn with status %s",
    async (status) => {
      await replaceSessionEntry(
        { sessionKey, storePath: fixture.storePath() },
        {
          sessionId: "session-1",
          status,
          updatedAt: 1,
        },
      );

      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("not-applicable");
      expect(
        loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
          ?.restartRecoveryDeliveryReceiptState,
      ).toBeUndefined();
    },
  );

  it("fails closed when the claimless live capability names a replaced session", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-2",
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
  });

  it("blocks a completed source after its active recovery claim is cleared", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-1",
        restartRecoveryTerminalRunIds: ["source-1"],
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("already-delivered");
  });

  it("clears pending only after a proven non-delivery", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("cleared");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBeUndefined();
  });

  it("does not mutate a replacement session", async () => {
    await seedClaim({ sessionId: "session-2", sourceTurnId: "source-2" });

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
  });
});
