import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { CodexAppServerScopedRequestRejectedError } from "./rpc-error.js";
import { waitForCodexThreadUnload } from "./thread-unload.js";

function createClient() {
  const notifications = new Set<Parameters<CodexAppServerClient["addNotificationHandler"]>[0]>();
  const exits = new Set<() => void>();
  const entered = Promise.withResolvers<void>();
  const request = vi.fn<CodexAppServerClient["request"]>().mockImplementation(async () => {
    entered.resolve();
    return { status: "unsubscribed" };
  });
  const client = {
    request,
    addNotificationHandler(handler: Parameters<CodexAppServerClient["addNotificationHandler"]>[0]) {
      notifications.add(handler);
      return () => notifications.delete(handler);
    },
    addTransportExitHandler(handler: () => void) {
      exits.add(handler);
      return () => exits.delete(handler);
    },
  };
  return {
    client,
    request,
    entered: entered.promise,
    closeThread(threadId = "thread", method = "thread/closed") {
      for (const handler of notifications) {
        void handler({ method, params: { threadId } });
      }
    },
    exit() {
      for (const handler of exits) {
        handler();
      }
    },
    expectReleased() {
      expect(notifications.size).toBe(0);
      expect(exits.size).toBe(0);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("waitForCodexThreadUnload", () => {
  it.each(["unsubscribed", "notSubscribed"])(
    "waits beyond %s for the exact thread, preserving a live sibling process",
    async (status) => {
      const test = createClient();
      const received = Promise.withResolvers<void>();
      test.request.mockImplementation(async () => {
        received.resolve();
        return { status };
      });
      const settled = vi.fn();
      const result = waitForCodexThreadUnload({
        client: test.client,
        threadId: "thread",
        release: async () => true,
      }).then(settled);
      await received.promise;
      test.closeThread("sibling");
      test.closeThread("thread", "thread/archived");
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      test.closeThread();
      await result;
      expect(settled).toHaveBeenCalledWith(true);
      test.expectReleased();
    },
  );

  it.each(["closed", "exited"])("observes %s during the ownership release", async (event) => {
    const test = createClient();
    await expect(
      waitForCodexThreadUnload({
        client: test.client,
        threadId: "thread",
        release: async () => {
          if (event === "closed") {
            test.closeThread();
          } else {
            test.exit();
          }
          return "released";
        },
      }),
    ).resolves.toBe("released");
    expect(test.request).not.toHaveBeenCalled();
    test.expectReleased();
  });

  it("accepts notLoaded when an earlier eviction predates observation", async () => {
    const test = createClient();
    test.request.mockResolvedValue({ status: "notLoaded" });
    await expect(
      waitForCodexThreadUnload({
        client: test.client,
        threadId: "thread",
        release: async () => false,
      }),
    ).resolves.toBe(false);
    test.expectReleased();
  });

  it("accepts physical exit when the confirmation RPC fails", async () => {
    const test = createClient();
    test.request.mockImplementation(async () => {
      test.exit();
      throw new Error("transport closed");
    });
    await expect(
      waitForCodexThreadUnload({
        client: test.client,
        threadId: "thread",
        release: async () => true,
      }),
    ).resolves.toBe(true);
    test.expectReleased();
  });

  it("preserves an RPC failure without physical teardown proof", async () => {
    const test = createClient();
    const failure = new Error("transport logically closed");
    test.request.mockRejectedValue(failure);
    await expect(
      waitForCodexThreadUnload({
        client: test.client,
        threadId: "thread",
        release: async () => true,
      }),
    ).rejects.toBe(failure);
    test.expectReleased();
  });

  it("preserves wire authority rejection even if the thread concurrently closes", async () => {
    const test = createClient();
    const failure = new CodexAppServerScopedRequestRejectedError("wire authority revoked");
    test.request.mockImplementation(async () => {
      test.closeThread();
      throw failure;
    });
    await expect(
      waitForCodexThreadUnload({
        client: test.client,
        threadId: "thread",
        release: async () => true,
      }),
    ).rejects.toBe(failure);
    test.expectReleased();
  });

  it("cancels the teardown wait and removes its observers", async () => {
    const test = createClient();
    const abort = new AbortController();
    const result = waitForCodexThreadUnload({
      client: test.client,
      threadId: "thread",
      signal: abort.signal,
      release: async () => true,
    });
    const failure = new Error("startup timed out");
    const rejected = expect(result).rejects.toBe(failure);
    await test.entered;
    abort.abort(failure);
    await rejected;
    test.expectReleased();
  });

  it("bounds command handoffs that lack a startup signal", async () => {
    vi.useFakeTimers();
    const test = createClient();
    const result = waitForCodexThreadUnload({
      client: test.client,
      threadId: "thread",
      release: async () => true,
    });
    const rejected = expect(result).rejects.toThrow("Codex thread unload timed out: thread");
    await test.entered;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await rejected;
    test.expectReleased();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("revalidates authority after release before sending another request", async () => {
    const test = createClient();
    const failure = new Error("owner revoked");
    let current = true;
    await expect(
      waitForCodexThreadUnload({
        client: test.client,
        threadId: "thread",
        assertCurrent: () => {
          if (!current) {
            throw failure;
          }
        },
        release: async () => {
          current = false;
          return true;
        },
      }),
    ).rejects.toBe(failure);
    expect(test.request).not.toHaveBeenCalled();
    test.expectReleased();
  });
});
