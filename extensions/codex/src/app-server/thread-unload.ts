import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject } from "./protocol.js";
import { CodexAppServerScopedRequestRejectedError } from "./rpc-error.js";

// Command callers may lack a startup signal. Allow the same generous ten-minute
// window as ordinary startup, without leaving a thread mutation lane stuck forever.
const THREAD_UNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Confirms one native writer has stopped without waiting for unrelated client leases. */
export async function waitForCodexThreadUnload<T>(params: {
  client: Pick<CodexAppServerClient, "request" | "addNotificationHandler"> & {
    addTransportExitHandler(handler: () => void): () => void;
  };
  threadId: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  withCurrent?: (write: () => void) => Promise<void>;
  release: () => Promise<T>;
}): Promise<T> {
  const fallback = params.signal ? undefined : new AbortController();
  const signal = params.signal ?? fallback!.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unloaded = false;
  const completion = Promise.withResolvers<void>();
  const confirm = () => {
    unloaded = true;
    completion.resolve();
  };
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertCurrent?.();
  };
  assertCurrent();
  // Unload can precede the unsubscribe response, including during the existing
  // ownership callback. Observe the physical client before invoking that callback.
  const removeNotification = params.client.addNotificationHandler((notification) => {
    if (
      notification.method === "thread/closed" &&
      isJsonObject(notification.params) &&
      notification.params.threadId === params.threadId
    ) {
      confirm();
    }
  });
  const removeExit = params.client.addTransportExitHandler(confirm);
  if (fallback) {
    timer = setTimeout(() => {
      fallback.abort(new Error(`Codex thread unload timed out: ${params.threadId}`));
    }, THREAD_UNLOAD_TIMEOUT_MS);
    timer.unref?.();
  }
  try {
    const result = await params.release();
    assertCurrent();
    if (!unloaded) {
      try {
        // A locally evicted subscription may already have unloaded before our
        // observer was installed. The idempotent RPC's notLoaded reply proves it;
        // unsubscribed/notSubscribed only acknowledge connection detachment.
        const response = await params.client.request(
          "thread/unsubscribe",
          { threadId: params.threadId },
          { signal, assertCurrent, withCurrent: params.withCurrent },
        );
        assertCurrent();
        if (isJsonObject(response) && response.status === "notLoaded") {
          confirm();
        }
      } catch (error) {
        assertCurrent();
        if (!unloaded || error instanceof CodexAppServerScopedRequestRejectedError) {
          throw error;
        }
      }
    }
    await racePromiseWithAbortSignal(completion.promise, signal, (aborted) => aborted.reason);
    assertCurrent();
    return result;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeNotification();
    removeExit();
  }
}
