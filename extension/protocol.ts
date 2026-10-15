export type PromptStatus = "pending" | "in_progress" | "completed" | "failed";
export type BatchStatus = "idle" | "running" | "paused" | "stopped" | "completed";

export interface BatchPrompt {
    id: string;
    text: string;
    status: PromptStatus;
    error?: string;
    baselineImageSources?: string[];
}

export interface BatchState {
    prompts: BatchPrompt[];
    status: BatchStatus;
    activePromptId: string | null;
    message: string;
    sourceFileName?: string;
}

export interface FlowRequest {
    type: "START_BATCH";
    stateKey: string;
}

export type FlowReply =
    | { protocolVersion: 1; ok: true; kind: "started"; message: string }
    | { protocolVersion: 1; ok: false; message: string };

export interface DownloadImageRequest {
    type: "DOWNLOAD_IMAGE";
    src: string;
    promptNumber: number;
}

/** Viewport CSS-pixel click delivered via chrome.debugger (isTrusted). */
export interface TrustedClickRequest {
    type: "TRUSTED_CLICK";
    x: number;
    y: number;
}

/** Key press delivered via chrome.debugger (isTrusted). */
export interface TrustedKeyRequest {
    type: "TRUSTED_KEY";
    key: "Enter" | "A";
    /** 2 = Ctrl (Windows/Linux), 4 = Meta (macOS). Used for Select-All. */
    modifiers?: number;
}

/** Insert text at the focused element via CDP Input.insertText. */
export interface TrustedInsertTextRequest {
    type: "TRUSTED_INSERT_TEXT";
    text: string;
}

export type BackgroundRequest =
    | DownloadImageRequest
    | TrustedClickRequest
    | TrustedKeyRequest
    | TrustedInsertTextRequest;

export type BackgroundReply =
    | { ok: true }
    | { ok: true; downloadId: number }
    | { ok: false; message: string };
