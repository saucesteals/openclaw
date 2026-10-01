import { describe, expect, it } from "vitest";
import { freezeCurrentRunDeliveryMedia } from "../../agents/agent-command-restart-recovery.js";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
  resolveRestartRecoverySteeringBlockReason,
} from "./restart-recovery-receipt.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  getRestartRecoveryTerminalDeliveryEvidence,
} from "./restart-recovery-state.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

describe("restart recovery terminal delivery receipt", () => {
  const fixture = useTempSessionsFixture("restart-receipt-");
  const sessionKey = "agent:main:discord:direct:123";
  const scope = () => ({
    sessionId: "session-1",
    sessionKey,
    sourceTurnId: "source-1",
    storePath: fixture.storePath(),
    toolCallId: "message-call-1",
  });
  const read = () => loadSessionEntry(scope());
  const seed = (fields: Partial<SessionEntry>) =>
    replaceSessionEntry(scope(), { sessionId: "session-1", updatedAt: 1, ...fields });
  const claim = {
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: "source-1",
  } as const;

  it("freezes under real ownership, keeps the whole set for subset sends, and refuses a stale lifecycle", async () => {
    await seed(claim);
    const storePath = fixture.storePath();
    const current = loadSessionEntry({ sessionKey, storePath })!;
    const sessionStore = { [sessionKey]: current };
    const base = {
      agentId: "main",
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
    await seed(claim);
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

  it.each(["success", "non-delivery"] as const)(
    "persists pending and blocks repeat sends until provider %s",
    async (outcome) => {
      await seed(claim);
      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
      expect(read()).toMatchObject({
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      });
      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe(
        "delivery-ambiguous",
      );
      if (outcome === "success") {
        await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
        expect(read()?.restartRecoveryDeliveryReceiptState).toBe("delivered-terminal");
      } else {
        await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("cleared");
        expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
        expect(read()?.restartRecoveryDeliveryToolCallId).toBeUndefined();
      }
    },
  );

  it.each<{
    name: string;
    fields: Partial<SessionEntry>;
    expected: string;
  }>([
    { name: "claimless live turn", fields: { status: undefined }, expected: "not-applicable" },
    { name: "claimless done turn", fields: { status: "done" }, expected: "not-applicable" },
    { name: "replaced claimless session", fields: { sessionId: "session-2" }, expected: "stale" },
    {
      name: "completed source with cleared claim",
      fields: { restartRecoveryTerminalRunIds: ["source-1"] },
      expected: "already-delivered",
    },
  ])("does not arm a receipt for $name", async ({ fields, expected }) => {
    await seed(fields);
    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe(expected);
    expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
  });

  it("does not mutate a replacement session", async () => {
    await seed({
      ...claim,
      sessionId: "session-2",
      restartRecoveryDeliverySourceRunId: "source-2",
    });
    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    expect(read()?.restartRecoveryDeliveryReceiptState).toBeUndefined();
  });
});

describe("restart recovery steering block reasons", () => {
  const claim: Partial<SessionEntry> = {
    status: undefined,
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: "source-1",
  };

  it.each<{
    name: string;
    fields?: Partial<SessionEntry>;
    sourceTurnId: string;
    reason: ReturnType<typeof resolveRestartRecoverySteeringBlockReason>;
  }>([
    {
      name: "terminal-pending receipt",
      fields: {
        ...claim,
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      },
      sourceTurnId: "source-1",
      reason: "terminal-pending",
    },
    {
      name: "delivered-terminal receipt",
      fields: {
        ...claim,
        restartRecoveryDeliveryReceiptState: "delivered-terminal",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      },
      sourceTurnId: "source-1",
      reason: "delivered-terminal",
    },
    {
      name: "unresolved terminal tool-call id",
      fields: { ...claim, restartRecoveryDeliveryToolCallId: "message-call-2" },
      sourceTurnId: "source-1",
      reason: "unresolved-terminal-tool",
    },
    {
      name: "terminal-source tombstone on the active source",
      fields: { status: undefined, restartRecoveryTerminalRunIds: ["source-1"] },
      sourceTurnId: "source-1",
      reason: "already-delivered",
    },
    {
      name: "claimless entry with an unrelated tombstone",
      fields: { status: undefined, restartRecoveryTerminalRunIds: ["source-old"] },
      sourceTurnId: "source-1",
      reason: undefined,
    },
    {
      name: "claimless entry with tombstones and an unknown active source",
      fields: { status: undefined, restartRecoveryTerminalRunIds: ["source-old"] },
      sourceTurnId: "",
      reason: "unknown-source-with-terminal-history",
    },
    {
      name: "stale claim",
      fields: { ...claim, status: "done", restartRecoveryDeliverySourceRunId: "source-2" },
      sourceTurnId: "source-1",
      reason: "stale-claim",
    },
    {
      name: "replaced session",
      fields: {
        status: undefined,
        sessionId: "session-2",
        restartRecoveryTerminalRunIds: ["source-1"],
      },
      sourceTurnId: "source-1",
      reason: "stale-claim",
    },
    {
      name: "claimless fresh entry",
      fields: { status: undefined },
      sourceTurnId: "",
      reason: undefined,
    },
    ...([undefined, "done", "interrupted"] as const).map((status) => ({
      name: `exact source claim with outcome ${status}`,
      fields: { ...claim, status },
      sourceTurnId: "source-1",
      reason: undefined,
    })),
    { name: "missing entry", sourceTurnId: "source-1", reason: undefined },
  ])("classifies $name", ({ fields, sourceTurnId, reason }) => {
    const entry = fields ? { sessionId: "session-1", updatedAt: 1, ...fields } : undefined;
    expect(resolveRestartRecoverySteeringBlockReason(entry, "session-1", sourceTurnId)).toBe(
      reason,
    );
  });
});
