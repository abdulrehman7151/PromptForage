import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { groupLinesIntoPrompts } from "../src/promptParser.js";
import type {
    BatchState,
    FlowReply,
    FlowRequest
} from "./protocol.js";

const STATE_KEY = "promptforage.batch.v1";
const DEFAULT_STATE: BatchState = {
    prompts: [],
    status: "idle",
    activePromptId: null,
    message: "Your prompt PDF stays in this browser."
};

const pdfFile = getElement<HTMLInputElement>("pdf-file");
const fileName = getElement<HTMLElement>("file-name");
const promptList = getElement<HTMLElement>("prompt-list");
const promptCount = getElement<HTMLElement>("prompt-count");
const batchStatus = getElement<HTMLElement>("batch-status");
const progressBar = getElement<HTMLElement>("progress-bar");
const progressSummary = getElement<HTMLElement>("progress-summary");
const currentPrompt = getElement<HTMLElement>("current-prompt");
const statusMessage = getElement<HTMLElement>("status-message");

let state: BatchState = DEFAULT_STATE;
let isBusy = false;

handleAction(loadState());

pdfFile.addEventListener("change", () => {
    handleAction(importPdf());
});
getElement<HTMLButtonElement>("change-pdf").addEventListener("click", () => {
    pdfFile.click();
});
getElement<HTMLButtonElement>("remove-pdf").addEventListener("click", () => {
    handleAction(removePdf());
});
getElement<HTMLButtonElement>("open-flow").addEventListener("click", () => {
    handleAction(chrome.tabs.create({ url: "https://flow.google.com/" }).then(() => undefined));
});
getElement<HTMLButtonElement>("start-batch").addEventListener("click", () => {
    handleAction(startBatch());
});
getElement<HTMLButtonElement>("resume-batch").addEventListener("click", () => {
    handleAction(resumeBatch());
});
getElement<HTMLButtonElement>("pause-batch").addEventListener("click", () => {
    handleAction(pauseBatch());
});
getElement<HTMLButtonElement>("stop-batch").addEventListener("click", () => {
    handleAction(stopBatch());
});
getElement<HTMLButtonElement>("retry-failed").addEventListener("click", () => {
    handleAction(retryFailedPrompts());
});
getElement<HTMLButtonElement>("resubmit-current").addEventListener("click", () => {
    handleAction(resubmitCurrentPrompt());
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[STATE_KEY]?.newValue) {
        const nextState = changes[STATE_KEY].newValue as BatchState;
        if (Array.isArray(nextState.prompts)) {
            state = nextState;
            render();
        }
    }
    if (changes.lastDownloadError?.newValue) {
        setMessage(String(changes.lastDownloadError.newValue));
    }
});

async function loadState(): Promise<void> {
    const result = await chrome.storage.local.get([STATE_KEY, "lastDownloadError"]);
    const stored = result[STATE_KEY] as BatchState | undefined;
    if (stored && Array.isArray(stored.prompts)) {
        state = stored;
    }
    if (typeof result.lastDownloadError === "string") {
        state.message = result.lastDownloadError;
    }
    render();
}

async function importPdf(): Promise<void> {
    const file = pdfFile.files?.[0];
    if (!file) return;
    if (state.status === "running") {
        setMessage("Pause the active batch before changing the PDF.");
        return;
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setMessage("Choose a PDF file.");
        return;
    }
    const activePrompt = state.prompts.find((prompt) => prompt.status === "in_progress");
    const replaceMessage = activePrompt
        ? `Replace the current prompt batch? Prompt ${activePrompt.id.slice(-3)} may still be generating in Flow, but PromptForage will stop tracking it. All saved prompts and progress will be cleared.`
        : "Replace the current prompt batch? All saved prompts and progress will be cleared.";
    if (state.prompts.length > 0 && !window.confirm(replaceMessage)) {
        pdfFile.value = "";
        return;
    }

    setBusy(true);
    try {
        GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");
        const documentTask = getDocument({
            data: new Uint8Array(await file.arrayBuffer()),
            cMapUrl: chrome.runtime.getURL("cmaps/"),
            cMapPacked: true,
            standardFontDataUrl: chrome.runtime.getURL("standard_fonts/"),
            wasmUrl: chrome.runtime.getURL("wasm/"),
            useWorkerFetch: false
        });
        const pdf = await documentTask.promise;
        const lines: string[] = [];

        try {
            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                const page = await pdf.getPage(pageNumber);
                try {
                    const content = await page.getTextContent();
                    collectTextItems(content.items, lines);
                } finally {
                    await page.cleanup();
                }
            }
        } finally {
            await documentTask.destroy();
        }

        const extracted = groupLinesIntoPrompts(lines);
        if (extracted.length === 0) {
            throw new Error("No numbered prompts found. Use numbering such as 1. or Prompt 1:.");
        }

        state = {
            prompts: extracted.map((text, index) => ({
                id: `prompt-${String(index + 1).padStart(3, "0")}`,
                text,
                status: "pending"
            })),
            status: "idle",
            activePromptId: null,
            message: `Imported ${extracted.length} prompts. Review and edit them before starting.`,
            sourceFileName: file.name
        };
        await persist();
    } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
        pdfFile.value = "";
        setBusy(false);
        render();
    }
}

async function removePdf(): Promise<void> {
    if (state.status === "running") {
        setMessage("Pause the active batch before removing the PDF.");
        return;
    }
    if (state.prompts.length === 0 && !state.sourceFileName) return;

    const activePrompt = state.prompts.find((prompt) => prompt.status === "in_progress");
    const confirmation = activePrompt
        ? `Remove this PDF and all saved prompts/progress? Prompt ${activePrompt.id.slice(-3)} may still be generating in Flow, but PromptForage will stop tracking it.`
        : "Remove this PDF and clear all saved prompts and progress? This cannot be undone.";
    if (!window.confirm(confirmation)) return;

    pdfFile.value = "";
    state = {
        prompts: [],
        status: "idle",
        activePromptId: null,
        message: "PDF removed. Choose another PDF to create a new prompt batch."
    };
    await persist();
}

function collectTextItems(items: unknown[], lines: string[]): void {
    let currentLine = "";
    let previousY: number | undefined;

    for (const item of items) {
        if (!isTextItem(item)) continue;
        if (previousY !== undefined && Math.abs(item.y - previousY) > 3) {
            if (currentLine.trim()) lines.push(currentLine.trim());
            currentLine = "";
        }
        currentLine += `${item.str} `;
        previousY = item.y;
    }

    if (currentLine.trim()) lines.push(currentLine.trim());
}

function isTextItem(value: unknown): value is { str: string; transform: number[]; y: number } {
    if (typeof value !== "object" || value === null) return false;
    const item = value as { str?: unknown; transform?: unknown };
    return typeof item.str === "string" &&
        Array.isArray(item.transform) &&
        typeof item.transform[5] === "number";
}

async function startBatch(): Promise<void> {
    if (state.prompts.length === 0) return;
    if (state.prompts.some((prompt) => prompt.status === "in_progress")) {
        setMessage("A prompt is already in progress. Use Resume to keep waiting, or Resubmit current if Flow never received it.");
        return;
    }
    await launchBatch();
}

async function resumeBatch(): Promise<void> {
    const active = state.prompts.find((prompt) => prompt.id === state.activePromptId);
    if (active?.status === "in_progress") {
        state.message = `Resuming observation for prompt ${active.id.slice(-3)}. It will not be sent again. If Flow never received it, use Resubmit current.`;
        await persist();
    }
    await launchBatch();
}

async function pauseBatch(): Promise<void> {
    state.status = "paused";
    state.message = "Paused. The current Flow generation will not be resubmitted.";
    await persist();
}

async function stopBatch(): Promise<void> {
    state.status = "stopped";
    state.message = "Stopped. Progress is saved; use Resume to continue waiting for an in-progress image.";
    await persist();
}

async function launchBatch(): Promise<void> {
    const hasPending = state.prompts.some((prompt) => prompt.status === "pending");
    const hasActive = state.prompts.some((prompt) => prompt.status === "in_progress");
    if (!hasPending && !hasActive) return;

    const flowTab = await getFlowTab();
    if (!flowTab) {
        state.status = "paused";
        state.message = "Opened Google Flow. Sign in and open a project, then select Resume.";
        await persist();
        await chrome.tabs.create({ url: "https://flow.google.com/" });
        return;
    }

    state.status = "running";
    state.message = "Connecting to Flow and starting automatic generation and downloads.";
    await persist();
    const reply = await sendToFlow({ type: "START_BATCH", stateKey: STATE_KEY }, flowTab);
    if (!reply.ok) {
        state.status = "paused";
        state.message = reply.message;
        await persist();
    }
}

async function retryFailedPrompts(): Promise<void> {
    for (const prompt of state.prompts) {
        if (prompt.status === "failed") {
            prompt.status = "pending";
            prompt.error = undefined;
            prompt.baselineImageSources = undefined;
        }
    }
    await launchBatch();
}

async function resubmitCurrentPrompt(): Promise<void> {
    if (state.status === "running") return;
    const prompt = state.prompts.find((item) => item.id === state.activePromptId && item.status === "in_progress")
        ?? state.prompts.find((item) => item.status === "in_progress");
    if (!prompt) {
        setMessage("There is no in-progress prompt to resubmit.");
        return;
    }
    if (!window.confirm(
        `Resubmit prompt ${prompt.id.slice(-3)}? This sends it to Flow again and may create a duplicate if Flow already accepted the earlier submission.`
    )) {
        return;
    }

    prompt.status = "pending";
    prompt.error = undefined;
    prompt.baselineImageSources = undefined;
    state.activePromptId = null;
    state.status = "running";
    state.message = `Resubmitting prompt ${prompt.id.slice(-3)} to Flow.`;
    await persist();
    await launchBatch();
}

async function sendToFlow(request: FlowRequest, existingTab?: chrome.tabs.Tab): Promise<FlowReply> {
    const tab = existingTab ?? await getFlowTab();
    if (!tab) {
        return { protocolVersion: 1, ok: false, message: "Open a Google Flow project, then retry this action." };
    }
    if (!tab.id) {
        return { protocolVersion: 1, ok: false, message: "Could not identify the Flow tab. Reopen it and retry." };
    }

    try {
        return await sendMessageToFlowTab(tab.id, request);
    } catch (error) {
        return {
            protocolVersion: 1,
            ok: false,
            message: `Could not connect to the Flow page: ${error instanceof Error ? error.message : String(error)}. Reload Flow and retry.`
        };
    }
}

async function sendMessageToFlowTab(tabId: number, request: FlowRequest): Promise<FlowReply> {
    try {
        const reply: unknown = await chrome.tabs.sendMessage(tabId, request);
        return isFlowReply(reply)
            ? reply
            : {
                protocolVersion: 1,
                ok: false,
                message: reply === undefined
                    ? "The Flow page did not respond. Check that this is an open Flow project, then retry."
                    : "The Flow page returned an incompatible response. Reload PromptForage and retry."
            };
    } catch (error) {
        if (!isMissingContentScriptError(error)) throw error;

        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"]
        });

        const reply: unknown = await chrome.tabs.sendMessage(tabId, request);
        return isFlowReply(reply)
            ? reply
            : {
                protocolVersion: 1,
                ok: false,
                message: "PromptForage connected to the Flow tab but received an incompatible response."
            };
    }
}

function isMissingContentScriptError(error: unknown): boolean {
    return error instanceof Error &&
        /receiving end does not exist|could not establish connection/i.test(error.message);
}

async function getFlowTab(): Promise<chrome.tabs.Tab | undefined> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    if (active?.url && isFlowProjectUrl(active.url)) return active;

    const flowTabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/fx/tools/flow/*"] });
    return flowTabs.find((tab) => tab.url && isFlowProjectUrl(tab.url));
}

function isFlowProjectUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.hostname === "flow.google.com"
            ? parsed.pathname !== "/about" && parsed.pathname !== "/about/"
            : parsed.hostname === "labs.google" &&
                (parsed.pathname === "/fx/tools/flow" || parsed.pathname.startsWith("/fx/tools/flow/"));
    } catch {
        return false;
    }
}

async function persist(): Promise<void> {
    await chrome.storage.local.set({ [STATE_KEY]: state });
    render();
}

function render(): void {
    const completed = state.prompts.filter((prompt) => prompt.status === "completed").length;
    const failed = state.prompts.filter((prompt) => prompt.status === "failed").length;
    const active = state.prompts.find((prompt) => prompt.id === state.activePromptId);
    const total = state.prompts.length;
    fileName.textContent = state.sourceFileName ??
        (total > 0 ? "Imported prompt batch (PDF name unavailable)" : "No PDF selected");
    promptCount.textContent = `${total} prompt${total === 1 ? "" : "s"}`;
    batchStatus.textContent = state.status.replace("_", " ");
    progressSummary.textContent = `${completed} of ${total} complete · ${failed} failed`;
    progressBar.style.width = total ? `${(completed / total) * 100}%` : "0%";
    currentPrompt.textContent = active
        ? `Current · ${active.id.slice(-3)}: ${active.text}`
        : total ? "No prompt currently in progress" : "No active prompt";
    statusMessage.textContent = state.message;

    const hasPending = state.prompts.some((prompt) => prompt.status === "pending");
    const hasInProgress = state.prompts.some((prompt) => prompt.status === "in_progress");
    const canResubmitCurrent = hasInProgress && state.status !== "running";
    setDisabled("change-pdf", isBusy || state.status === "running");
    setDisabled("remove-pdf", isBusy || state.status === "running" ||
        (state.prompts.length === 0 && !state.sourceFileName));
    setDisabled("start-batch", isBusy || !hasPending || state.prompts.length === 0 || !!active);
    setDisabled("pause-batch", isBusy || state.status !== "running");
    setDisabled("resume-batch", isBusy || (!hasPending && !hasInProgress) || state.status === "running" || state.status === "completed");
    setDisabled("stop-batch", isBusy || state.status === "idle" || state.status === "stopped" || state.status === "completed");
    setDisabled("resubmit-current", isBusy || !canResubmitCurrent);
    setDisabled("retry-failed", isBusy || failed === 0 || !!active);

    promptList.replaceChildren();
    if (total === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "Import a PDF to review its numbered prompts.";
        promptList.append(empty);
        return;
    }

    state.prompts.forEach((prompt, index) => {
        const card = document.createElement("article");
        card.className = "prompt-item";
        const header = document.createElement("div");
        header.className = "prompt-item-top";
        const number = document.createElement("span");
        number.className = "prompt-number";
        number.textContent = `PROMPT ${String(index + 1).padStart(3, "0")}`;
        const status = document.createElement("span");
        status.className = "prompt-state";
        status.textContent = prompt.status.replace("_", " ");
        const textarea = document.createElement("textarea");
        textarea.value = prompt.text;
        textarea.setAttribute("aria-label", `Prompt ${index + 1}`);
        textarea.disabled = prompt.status === "in_progress";
        textarea.addEventListener("change", () => {
            prompt.text = textarea.value.trim();
            handleAction(persist());
        });
        header.append(number, status);
        card.append(header, textarea);
        if (prompt.error) {
            const error = document.createElement("p");
            error.className = "prompt-error";
            error.textContent = prompt.error;
            card.append(error);
        }
        promptList.append(card);
    });
}

function setMessage(message: string): void {
    state.message = message;
    render();
}

function handleAction(action: Promise<unknown>): void {
    void action.catch((error: unknown) => {
        state.message = `Action failed: ${error instanceof Error ? error.message : String(error)}`;
        render();
    });
}

function setBusy(busy: boolean): void {
    isBusy = busy;
    render();
}

function setDisabled(id: string, disabled: boolean): void {
    getElement<HTMLButtonElement>(id).disabled = disabled;
}

function getElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Required extension element #${id} was not found.`);
    return element as T;
}

function isFlowReply(value: unknown): value is FlowReply {
    if (typeof value !== "object" || value === null ||
        !("protocolVersion" in value) || value.protocolVersion !== 1 ||
        !("ok" in value) || typeof value.ok !== "boolean") {
        return false;
    }
    if (!value.ok) return "message" in value && typeof value.message === "string";
    if (!("kind" in value) || typeof value.kind !== "string") return false;
    return value.kind === "started" &&
        "message" in value && typeof value.message === "string";
}
