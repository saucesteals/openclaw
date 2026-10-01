import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { projectTranscriptNavigationFields } from "./transcript-navigation-fields.js";

const BRANCH_HEADLINE_MAX_CHARS = 120;
export type SessionBranchTranscriptEntry = Record<string, unknown> & {
  seq: number;
  headlineCandidate: boolean;
};

export function projectSessionBranchEntry(
  event: TranscriptEvent,
  seq: number,
): SessionBranchTranscriptEntry | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const role = asRecord(record.message)?.role;
  const entry: SessionBranchTranscriptEntry = {
    seq,
    headlineCandidate: record.type === "message" && (role === "user" || role === "assistant"),
    ...projectTranscriptNavigationFields(record),
  };
  if (typeof record.timestamp === "string" && record.timestamp.trim()) {
    entry.timestamp = record.timestamp;
  }
  return entry;
}

export function extractSessionBranchHeadline(event: TranscriptEvent): string | undefined {
  const record = asRecord(event);
  const headline = record?.type === "message" ? extractHeadlineText(record.message) : undefined;
  return headline === undefined ? undefined : truncateBranchHeadline(headline);
}

function extractHeadlineText(messageValue: unknown): string | undefined {
  const message = asRecord(messageValue);
  if (message?.role !== "user" && message?.role !== "assistant") {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : extractEditorText(message.content ?? message.text);
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncateBranchHeadline(value: string): string {
  const prefix = truncateCodePoints(value, BRANCH_HEADLINE_MAX_CHARS);
  return prefix.length === value.length
    ? prefix
    : `${truncateCodePoints(prefix, BRANCH_HEADLINE_MAX_CHARS - 1)}…`;
}

export function extractEditorText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
  return text || undefined;
}

// Gateway-written inline images are already size-capped at send time; these bounds
// only keep a corrupted transcript from ballooning the rewind/fork response.
const EDITOR_ATTACHMENT_LIMIT = 10;
const EDITOR_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

export function extractEditorAttachments(
  content: unknown,
): Array<{ mimeType: string; data: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const attachments = content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "image" &&
      typeof record.data === "string" &&
      record.data.trim() &&
      record.data.length <= EDITOR_ATTACHMENT_MAX_BASE64_CHARS &&
      typeof record.mimeType === "string" &&
      record.mimeType.startsWith("image/")
      ? [{ mimeType: record.mimeType, data: record.data }]
      : [];
  });
  return attachments.length > 0 ? attachments.slice(0, EDITOR_ATTACHMENT_LIMIT) : undefined;
}

export function extractEditorMediaRefs(
  message: Record<string, unknown>,
): Array<{ path: string; contentType: string }> | undefined {
  const media = asRecord(message["__openclaw"])?.media;
  if (!Array.isArray(media)) {
    return undefined;
  }
  const refs = media.flatMap((entry) => {
    const record = asRecord(entry);
    const mediaUrl = typeof record?.url === "string" ? record.url.trim() : undefined;
    const mediaPath =
      mediaUrl === undefined
        ? typeof record?.path === "string"
          ? record.path.trim()
          : ""
        : /^media:\/\//i.test(mediaUrl)
          ? mediaUrl
          : "";
    const contentType = record?.contentType;
    return mediaPath && typeof contentType === "string" && contentType.startsWith("image/")
      ? [{ path: mediaPath, contentType }]
      : [];
  });
  return refs.length > 0 ? refs : undefined;
}
