import type {
    BackgroundReply,
    BackgroundRequest,
    DownloadImageRequest,
    TrustedClickRequest,
    TrustedInsertTextRequest,
    TrustedKeyRequest
} from "./protocol.js";

const DOWNLOAD_COMPLETION_TIMEOUT_MS = 3 * 60 * 1000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const DEBUGGER_COMMAND_TIMEOUT_MS = 8_000;
const attachedTabs = new Set<number>();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isBackgroundRequest(message)) {
        return false;
    }

    void (async () => {
        try {
            if (message.type === "DOWNLOAD_IMAGE") {
                sendResponse(await handleDownload(message));
                return;
            }

            const tabId = sender.tab?.id;
            if (typeof tabId !== "number") {
                sendResponse({ ok: false, message: "Trusted input requires an active Flow tab." });
                return;
            }

            if (message.type === "TRUSTED_CLICK") {
                await trustedClick(tabId, message.x, message.y);
                sendResponse({ ok: true } satisfies BackgroundReply);
                return;
            }

            if (message.type === "TRUSTED_KEY") {
                await trustedKey(tabId, message);
                sendResponse({ ok: true } satisfies BackgroundReply);
                return;
            }

            await trustedInsertText(tabId, message.text);
            sendResponse({ ok: true } satisfies BackgroundReply);
        } catch (error) {
            sendResponse({
                ok: false,
                message: error instanceof Error ? error.message : String(error)
            } satisfies BackgroundReply);
        }
    })();

    return true;
});

async function handleDownload(message: DownloadImageRequest): Promise<BackgroundReply> {
    await chrome.storage.local.remove("lastDownloadError");
    const downloadId = await chrome.downloads.download({
        url: message.src,
        filename: `PromptForage/prompt-${String(message.promptNumber).padStart(3, "0")}${getImageExtension(message.src)}`,
        conflictAction: "uniquify",
        saveAs: false
    });
    await waitForDownload(downloadId);
    return { ok: true, downloadId };
}

async function trustedClick(tabId: number, x: number, y: number): Promise<void> {
    const clickX = Math.round(x);
    const clickY = Math.round(y);
    await withDebugger(tabId, async (target) => {
        await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: clickX,
            y: clickY
        });
        await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            x: clickX,
            y: clickY,
            clickCount: 1
        });
        await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            x: clickX,
            y: clickY,
            clickCount: 1
        });
    });
}

async function trustedKey(tabId: number, message: TrustedKeyRequest): Promise<void> {
    await withDebugger(tabId, async (target) => {
        const base =
            message.key === "Enter"
                ? {
                    key: "Enter",
                    code: "Enter",
                    windowsVirtualKeyCode: 13,
                    nativeVirtualKeyCode: 13
                }
                : {
                    key: "a",
                    code: "KeyA",
                    windowsVirtualKeyCode: 65,
                    nativeVirtualKeyCode: 65,
                    modifiers: message.modifiers ?? 2
                };

        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            ...base
        });
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
            type: "keyUp",
            ...base
        });
    });
}

async function trustedInsertText(tabId: number, text: string): Promise<void> {
    await withDebugger(tabId, async (target) => {
        await sendDebuggerCommand(target, "Input.insertText", { text });
    });
}

async function withDebugger(
    tabId: number,
    run: (target: chrome.debugger.Debuggee) => Promise<void>
): Promise<void> {
    const target: chrome.debugger.Debuggee = { tabId };
    const alreadyAttached = attachedTabs.has(tabId);
    if (!alreadyAttached) {
        try {
            await withTimeout(
                chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION),
                DEBUGGER_COMMAND_TIMEOUT_MS,
                "Debugger attach"
            );
            attachedTabs.add(tabId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/already attached/i.test(message)) {
                throw new Error(
                    `Could not attach the debugger for trusted Flow input: ${message}. ` +
                    "Reload PromptForage after approving the debugger permission, then reload the Flow tab."
                );
            }
            attachedTabs.add(tabId);
        }
    }

    try {
        await run(target);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Trusted Flow input failed: ${message}`);
    } finally {
        // Detach so the yellow bar does not linger and the tab does not stay paused.
        try {
            await chrome.debugger.detach(target);
        } catch {
            // Ignore detach races.
        }
        attachedTabs.delete(tabId);
    }
}

async function sendDebuggerCommand(
    target: chrome.debugger.Debuggee,
    method: string,
    params?: Record<string, unknown>
): Promise<void> {
    await withTimeout(
        chrome.debugger.sendCommand(target, method, params),
        DEBUGGER_COMMAND_TIMEOUT_MS,
        method
    );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timeoutId);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timeoutId);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        );
    });
}

chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") attachedTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
});

function waitForDownload(downloadId: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error("Chrome did not finish the image download within three minutes."));
        }, DOWNLOAD_COMPLETION_TIMEOUT_MS);

        const cleanup = (): void => {
            clearTimeout(timeoutId);
            chrome.downloads.onChanged.removeListener(onChanged);
        };

        const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
            if (delta.id !== downloadId) return;
            if (delta.state?.current === "complete") {
                cleanup();
                resolve();
            } else if (delta.state?.current === "interrupted" || delta.error?.current) {
                cleanup();
                reject(new Error(delta.error?.current ?? "Chrome interrupted the image download."));
            }
        };

        chrome.downloads.onChanged.addListener(onChanged);
        void chrome.downloads.search({ id: downloadId }).then((items) => {
            const item = items[0];
            if (item?.state === "complete") {
                cleanup();
                resolve();
            } else if (item?.state === "interrupted") {
                cleanup();
                reject(new Error(item.error ?? "Chrome interrupted the image download."));
            }
        }).catch((error: unknown) => {
            cleanup();
            reject(error);
        });
    });
}

chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.error?.current) return;
    void (async () => {
        try {
            const items = await chrome.downloads.search({ id: delta.id });
            const filename = items[0]?.filename ?? `download ${delta.id}`;
            await chrome.storage.local.set({
                lastDownloadError: `Download failed for ${filename}: ${delta.error?.current}`
            });
        } catch (error) {
            const message = `Download ${delta.id} failed and could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
            console.error(message);
            try {
                await chrome.storage.local.set({ lastDownloadError: message });
            } catch (storageError) {
                console.error("Could not save the download error:", storageError);
            }
        }
    })();
});

function isBackgroundRequest(value: unknown): value is BackgroundRequest {
    if (typeof value !== "object" || value === null || !("type" in value)) return false;
    const type = (value as { type: unknown }).type;
    if (type === "DOWNLOAD_IMAGE") return isDownloadRequest(value);
    if (type === "TRUSTED_CLICK") {
        const candidate = value as Partial<TrustedClickRequest>;
        return typeof candidate.x === "number" && typeof candidate.y === "number" &&
            Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
    }
    if (type === "TRUSTED_KEY") {
        const candidate = value as Partial<TrustedKeyRequest>;
        return candidate.key === "Enter" || candidate.key === "A";
    }
    if (type === "TRUSTED_INSERT_TEXT") {
        const candidate = value as Partial<TrustedInsertTextRequest>;
        return typeof candidate.text === "string" && candidate.text.length > 0;
    }
    return false;
}

function isDownloadRequest(value: unknown): value is DownloadImageRequest {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Partial<DownloadImageRequest>;
    let isHttpsUrl = false;
    try {
        isHttpsUrl = new URL(candidate.src ?? "").protocol === "https:";
    } catch {
        return false;
    }
    return candidate.type === "DOWNLOAD_IMAGE" &&
        typeof candidate.src === "string" &&
        isHttpsUrl &&
        Number.isInteger(candidate.promptNumber) &&
        (candidate.promptNumber ?? 0) > 0;
}

function getImageExtension(src: string): string {
    try {
        const extension = new URL(src).pathname.match(/\.(png|jpe?g|webp|gif)$/i)?.[0];
        return extension?.toLowerCase() ?? ".png";
    } catch {
        return ".png";
    }
}
