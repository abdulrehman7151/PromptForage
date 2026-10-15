import type {
    BackgroundReply,
    BatchPrompt,
    BatchState,
    FlowReply,
    FlowRequest
} from "./protocol.js";

const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const IMAGE_QUIET_PERIOD_MS = 10 * 1000;
const POLL_INTERVAL_MS = 1500;
const SUBMISSION_TIMEOUT_MS = 20 * 1000;

declare global {
    interface Window {
        __promptForageContentReady?: boolean;
    }
}

let activeRun: Promise<void> | undefined;

if (!window.__promptForageContentReady) {
    window.__promptForageContentReady = true;

    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
        if (!isFlowRequest(message)) return false;

        if (!activeRun) {
            activeRun = runBatch(message.stateKey)
                .catch((error: unknown) => {
                    if (isExtensionContextInvalidated(error)) {
                        console.warn(
                            "PromptForage was reloaded while this batch was running. The Flow content script stopped; check Flow before resuming."
                        );
                        return;
                    }
                    return handleBatchError(message.stateKey, error);
                })
                .finally(() => {
                    activeRun = undefined;
                });
        }

        const reply: FlowReply = {
            protocolVersion: 1,
            ok: true,
            kind: "started",
            message: "Automatic batch started. Keep this Flow tab open while it runs."
        };
        sendResponse(reply);
        return false;
    });
}

async function runBatch(stateKey: string): Promise<void> {
    while (true) {
        const state = await readState(stateKey);
        if (!state || state.status !== "running") return;

        let prompt = state.prompts.find((item) => item.status === "in_progress");
        if (!prompt) {
            prompt = state.prompts.find((item) => item.status === "pending");
            if (!prompt) {
                await updateState(stateKey, (current) => {
                    current.status = current.prompts.every((item) => item.status === "completed")
                        ? "completed"
                        : "paused";
                    current.activePromptId = null;
                    current.message = current.status === "completed"
                        ? "All prompts were generated and downloaded."
                        : "No pending prompts remain. Retry failed prompts to continue.";
                });
                return;
            }

            const baseline = listCandidateImages().slice(-100).map((image) => image.src);
            await updateState(stateKey, (current) => {
                const selected = current.prompts.find((item) => item.id === prompt?.id);
                if (!selected || current.status !== "running") return;
                selected.status = "in_progress";
                selected.error = undefined;
                selected.baselineImageSources = baseline;
                current.activePromptId = selected.id;
                current.message = `Submitting prompt ${selected.id.slice(-3)} to Flow.`;
            });

            const refreshed = await readState(stateKey);
            const activePrompt = refreshed?.prompts.find((item) => item.id === prompt?.id);
            if (!refreshed || refreshed.status !== "running" || !activePrompt) return;

            await updateState(stateKey, (current) => {
                current.message = `Waiting for Flow's prompt box before prompt ${activePrompt.id.slice(-3)}.`;
            });
            const readyError = await ensureComposerReady(stateKey);
            if (readyError) {
                await failPrompt(stateKey, activePrompt.id, readyError);
                return;
            }

            const submissionError = await submitPrompt(stateKey, activePrompt);
            if (submissionError) {
                await failPrompt(stateKey, activePrompt.id, submissionError);
                return;
            }
            prompt = activePrompt;
        }

        const result = await waitForGeneratedImages(stateKey, prompt);
        if (result.kind === "paused" || result.kind === "stopped") return;
        if (result.kind === "retry") continue;
        if (result.kind === "failed") {
            await failPrompt(stateKey, prompt.id, result.message);
            return;
        }

        await updateState(stateKey, (current) => {
            const selected = current.prompts.find((item) => item.id === prompt?.id);
            if (!selected) return;
            selected.status = "completed";
            selected.error = undefined;
            selected.baselineImageSources = undefined;
            current.activePromptId = null;
            current.message = `Prompt ${selected.id.slice(-3)} generated and downloaded. Preparing the next prompt.`;
        });

        // Flow briefly hides/rebuilds the composer after a generation finishes.
        await delay(2000);
        await waitUntil(
            () => !hasGenerationBusyIndicator() && findPromptFields().length > 0,
            SUBMISSION_TIMEOUT_MS
        );
    }
}

async function waitForGeneratedImages(
    stateKey: string,
    prompt: BatchPrompt
): Promise<
    | { kind: "complete" }
    | { kind: "paused" | "stopped" | "retry" }
    | { kind: "failed"; message: string }
> {
    const baseline = new Set(prompt.baselineImageSources ?? []);
    let activeElapsedMs = 0;
    let lastTickAt = Date.now();
    let lastStatusUpdateAt = 0;
    let lastNewImageAt: number | undefined;
    let knownNewSources = new Set<string>();
    let stableImages: ReturnType<typeof listCandidateImages> = [];
    const wasResumedWithoutBaseline = prompt.baselineImageSources === undefined;

    if (wasResumedWithoutBaseline) {
        await updateState(stateKey, (current) => {
            const selected = current.prompts.find((item) => item.id === prompt.id);
            if (selected) selected.baselineImageSources = listCandidateImages().slice(-100).map((image) => image.src);
        });
        const refreshed = await readState(stateKey);
        const selected = refreshed?.prompts.find((item) => item.id === prompt.id);
        if (!selected) return { kind: "failed", message: "Could not restore the active prompt state." };
        for (const src of selected.baselineImageSources ?? []) baseline.add(src);
    }

    while (activeElapsedMs < GENERATION_TIMEOUT_MS) {
        const state = await readState(stateKey);
        if (!state) return { kind: "stopped" };
        const currentPrompt = state.prompts.find((item) => item.id === prompt.id);
        if (state.status === "stopped") return { kind: "stopped" };
        if (!currentPrompt || currentPrompt.status !== "in_progress") {
            return state.status === "running" ? { kind: "retry" } : { kind: "stopped" };
        }
        if (state.status === "paused") {
            await delay(POLL_INTERVAL_MS);
            lastTickAt = Date.now();
            continue;
        }

        const now = Date.now();
        activeElapsedMs += now - lastTickAt;
        lastTickAt = now;
        const currentSources = listCandidateImages().filter((image) => !baseline.has(image.src));
        const nextSources = new Set(currentSources.map((image) => image.src));
        const hasChanged = nextSources.size !== knownNewSources.size ||
            [...nextSources].some((src) => !knownNewSources.has(src));

        if (nextSources.size > 0) {
            stableImages = currentSources;
            if (hasChanged || lastNewImageAt === undefined) lastNewImageAt = Date.now();
            if (Date.now() - lastNewImageAt >= IMAGE_QUIET_PERIOD_MS && !hasGenerationBusyIndicator()) {
                break;
            }
        }

        knownNewSources = nextSources;
        if (now - lastStatusUpdateAt >= 10_000) {
            lastStatusUpdateAt = now;
            await updateState(stateKey, (current) => {
                current.message = nextSources.size > 0
                    ? `Waiting for Flow to finish rendering prompt ${prompt.id.slice(-3)}.`
                    : `Waiting for a new Flow image for prompt ${prompt.id.slice(-3)}.`;
            });
        }
        await delay(POLL_INTERVAL_MS);
    }

    if (stableImages.length === 0 || activeElapsedMs >= GENERATION_TIMEOUT_MS) {
        return {
            kind: "failed",
            message: `Timed out waiting for a new Flow image after ${Math.round(GENERATION_TIMEOUT_MS / 60000)} minutes. Check Flow before retrying.`
        };
    }

    const finalState = await readState(stateKey);
    if (!finalState || finalState.status === "stopped") return { kind: "stopped" };
    if (finalState.status === "paused") return { kind: "paused" };

    for (const image of stableImages) {
        const downloadResult = await requestDownload(image.src, prompt.id);
        if (!downloadResult.ok) {
            return { kind: "failed", message: downloadResult.message };
        }
    }
    return { kind: "complete" };
}

async function ensureComposerReady(stateKey: string): Promise<string | undefined> {
    leaveAgentModeIfNeeded();
    revealComposer();

    const ready = await waitUntil(() => {
        leaveAgentModeIfNeeded();
        revealComposer();
        return pickPromptField(findPromptFields()) !== undefined && !hasGenerationBusyIndicator();
    }, SUBMISSION_TIMEOUT_MS);

    if (!ready) {
        if (findPromptFields().length === 0) {
            return "No visible Flow prompt field was found after the previous generation. Click into Flow's prompt box once, keep the project open, then retry.";
        }
        await updateState(stateKey, (state) => {
            state.message = "Flow still looks busy; continuing once the prompt box is usable.";
        });
    }
    return undefined;
}

function leaveAgentModeIfNeeded(): void {
    const pressedChip = document.querySelector<HTMLElement>(
        'button.agent-mode-chip[aria-pressed="true"], [role="button"].agent-mode-chip[aria-pressed="true"]'
    );
    if (pressedChip) pressedChip.click();

    // Some builds label the chip with accessible text instead of the class name.
    for (const button of findButtons()) {
        if (/^agent$/i.test(button.label) && button.element.getAttribute("aria-pressed") === "true") {
            button.element.click();
        }
    }
}

function revealComposer(): void {
    const markers = document.querySelectorAll<HTMLElement>(
        '.flow-prompt-box, [class*="prompt-box"], [class*="composer"], footer, [role="textbox"]'
    );
    const marker = Array.from(markers).at(-1);
    marker?.scrollIntoView({ block: "center", inline: "nearest" });
    if (!marker) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    }
}

function pickPromptField(
    fields: Array<{ element: HTMLElement; score: number }>
): { element: HTMLElement; score: number } | undefined {
    if (fields.length === 0) return undefined;

    const active = document.activeElement;
    const focused = fields.find((field) => field.element === active);
    if (focused) return focused;

    const bestScore = Math.max(...fields.map((field) => field.score));
    const best = fields.filter((field) => field.score === bestScore);
    if (best.length === 1) return best[0];

    // After the first generation, multiple editors can exist; prefer the bottom composer.
    return [...best].sort((left, right) => {
        const leftRect = left.element.getBoundingClientRect();
        const rightRect = right.element.getBoundingClientRect();
        if (rightRect.top !== leftRect.top) return rightRect.top - leftRect.top;
        return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    })[0];
}

async function submitPrompt(stateKey: string, prompt: BatchPrompt): Promise<string | undefined> {
    const target = pickPromptField(findPromptFields());
    if (!target) return "No visible Flow prompt field was found. Open a project and retry.";

    await updateState(stateKey, (state) => {
        state.message = `Writing prompt ${prompt.id.slice(-3)} into Flow.`;
    });
    target.element.scrollIntoView({ block: "center", inline: "nearest" });
    const writeResult = await writePromptTrusted(target.element, prompt.text);
    if (!writeResult.ok) return writeResult.message;

    // Re-query after writing; Flow may remount the submit control when the composer updates.
    const matching = findGenerationButtons(target.element);
    if (matching.length === 0) {
        return "Flow prompt was entered, but no supported generation button was found. The prompt was not submitted.";
    }

    const chosen = pickBestGenerationButton(matching, target.element);
    const button = chosen.element;
    const blocker = getFlowBlockerMessage();
    if (blocker) return blocker;

    const enabled = await waitUntil(
        () => isButtonEnabled(button),
        SUBMISSION_TIMEOUT_MS
    );
    if (!enabled) {
        return `Flow prompt ${prompt.id.slice(-3)} was entered, but its generation button stayed disabled. Check credits, Image mode, and the prompt, then retry.`;
    }

    await updateState(stateKey, (state) => {
        state.message = `Prompt ${prompt.id.slice(-3)} entered. Clicking Flow's ${chosen.label} (trusted).`;
    });
    const baselineSources = new Set(prompt.baselineImageSources ?? []);

    // Only the submit click uses chrome.debugger. Typing via CDP was hanging the tab.
    const clickResult = await trustedClickElement(button);
    if (!clickResult.ok) return clickResult.message;

    let ack = await waitForSubmissionAcknowledgment(
        prompt.text,
        baselineSources,
        Math.min(8000, SUBMISSION_TIMEOUT_MS)
    );
    if (ack.blocker) return ack.blocker;
    if (!ack.ok) {
        await updateState(stateKey, (state) => {
            state.message = `Prompt ${prompt.id.slice(-3)} click ignored. Sending trusted Enter.`;
        });
        target.element.focus();
        const enterResult = await sendTrustedKey("Enter");
        if (!enterResult.ok) return enterResult.message;
        ack = await waitForSubmissionAcknowledgment(
            prompt.text,
            baselineSources,
            SUBMISSION_TIMEOUT_MS
        );
        if (ack.blocker) return ack.blocker;
    }
    if (!ack.ok) {
        // Later prompts often keep the same composer text/button state; if a new image
        // appears soon, continue instead of failing a successful submit.
        const lateImage = await waitUntil(
            () => listCandidateImages().some((image) => !baselineSources.has(image.src)),
            15_000
        );
        if (!lateImage) {
            return `Tried a trusted click on Flow's ${chosen.label} button and trusted Enter for prompt ${prompt.id.slice(-3)}, but Flow did not acknowledge the submission. Turn Agent off, confirm Image mode and credits, then check Flow before retrying to avoid duplicates.`;
        }
    }
    await updateState(stateKey, (state) => {
        state.message = `Flow accepted prompt ${prompt.id.slice(-3)}. Waiting for the new image.`;
    });
    return undefined;
}

async function waitForSubmissionAcknowledgment(
    promptText: string,
    baselineSources: Set<string>,
    timeoutMs: number
): Promise<{ ok: boolean; blocker?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const submissionBlocker = getFlowBlockerMessage();
        if (submissionBlocker) return { ok: false, blocker: submissionBlocker };
        if (hasSubmissionAcknowledgment(promptText, baselineSources)) return { ok: true };
        await delay(100);
    }
    const submissionBlocker = getFlowBlockerMessage();
    if (submissionBlocker) return { ok: false, blocker: submissionBlocker };
    return { ok: hasSubmissionAcknowledgment(promptText, baselineSources) };
}

function readPromptField(element: HTMLElement): string {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value;
    }
    return element.innerText || element.textContent || "";
}

function hasSubmissionAcknowledgment(promptText: string, baselineSources: Set<string>): boolean {
    const generationButtons = findGenerationButtons();
    if (generationButtons.some(({ element }) => !isButtonEnabled(element))) {
        return true;
    }

    const currentPromptField = findPromptFields()
        .sort((left, right) => right.score - left.score)[0]?.element;
    if (currentPromptField && !promptFieldMatches(currentPromptField, promptText)) {
        return true;
    }
    if (listCandidateImages().some((image) => !baselineSources.has(image.src))) {
        return true;
    }
    if (hasGenerationBusyIndicator()) return true;
    return hasAgentOrConfirmationUi();
}

function hasAgentOrConfirmationUi(): boolean {
    const pageText = document.body.innerText.toLowerCase();
    return /confirm before generating|approve(?:\s+and)?(?:\s+don'?t ask)?|generation queued|creating your|generating your|started generating/i.test(pageText);
}

function getFlowBlockerMessage(): string | undefined {
    const pageText = document.body.innerText.toLowerCase();
    if (/could not connect to the recaptcha service|recaptcha.{0,40}(unavailable|failed|error)/i.test(pageText)) {
        return "Google Flow reports it cannot connect to the reCAPTCHA service. PromptForage cannot bypass this check. Reload Flow, verify your connection, and complete any challenge manually before retrying.";
    }
    if (/insufficient credits|not enough credits|out of credits|you need more credits/i.test(pageText)) {
        return "Google Flow reports insufficient credits for this generation. Choose a cheaper model or add credits, then retry.";
    }
    if (
        document.querySelector("button.prompt-warning-button") ||
        Array.from(document.querySelectorAll("[aria-label]")).some((element) =>
            /insufficient credits/i.test(element.getAttribute("aria-label") || "")
        )
    ) {
        return "Google Flow is showing an insufficient-credits warning instead of the submit control. Fix credits, then retry.";
    }
    return undefined;
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await delay(100);
    }
    return condition();
}

function findPromptFields(): Array<{ element: HTMLElement; score: number }> {
    return Array.from(document.querySelectorAll<HTMLElement>(
        'textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
    ))
        .filter((element) =>
            isVisible(element) &&
            !element.hasAttribute("disabled") &&
            element.getAttribute("aria-disabled") !== "true"
        )
        .map((element) => {
            const description = [
                element.getAttribute("aria-label"),
                element.getAttribute("placeholder"),
                element.getAttribute("data-placeholder"),
                element.getAttribute("title"),
                element.getAttribute("role"),
                element.closest('[class*="prompt"], [class*="composer"]')?.className
            ].filter(Boolean).join(" ").toLowerCase();
            const inPromptBox = Boolean(element.closest(
                '.flow-prompt-box, [class*="prompt-box"], [class*="composer"]'
            ));
            return {
                element,
                score: (/prompt|describe|image|scene|generate|write|composer/i.test(description) ? 10 : 0) +
                    (inPromptBox ? 8 : 0) +
                    (element.matches("textarea, [contenteditable]") ? 1 : 0)
            };
        });
}

function findButtons(): Array<{ element: HTMLButtonElement; label: string }> {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('button, [role="button"]'))
        .filter((element) => isVisible(element))
        .map((element) => {
            const labeled = normalizeLabel(
                element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                element.innerText
            );
            return {
                element,
                label: labeled || (buttonHasSubmitIcon(element) ? "arrow_forward" : "")
            };
        })
        .filter(({ label }) => label.length > 0);
}

function findGenerationButtons(
    near?: HTMLElement
): Array<{ element: HTMLButtonElement; label: string }> {
    const matches = findButtons().filter(({ element, label }) =>
        isGenerationSubmitButton(label, element)
    );
    if (!near || matches.length <= 1) return matches;
    return [...matches].sort(
        (left, right) => distanceBetween(near, left.element) - distanceBetween(near, right.element)
    );
}

function pickBestGenerationButton(
    buttons: Array<{ element: HTMLButtonElement; label: string }>,
    near: HTMLElement
): { element: HTMLButtonElement; label: string } {
    return [...buttons].sort((left, right) => {
        const scoreDelta = generationButtonScore(right, near) - generationButtonScore(left, near);
        if (scoreDelta !== 0) return scoreDelta;
        return distanceBetween(near, left.element) - distanceBetween(near, right.element);
    })[0];
}

function generationButtonScore(
    button: { element: HTMLButtonElement; label: string },
    near: HTMLElement
): number {
    const label = normalizeLabel(button.label);
    let score = 0;
    if (buttonHasSubmitIcon(button.element) || /^arrow_forward$/i.test(label)) score += 100;
    else if (/^generate(?:\s+(?:image|images))?$/i.test(label)) score += 90;
    else if (/^create$/i.test(label)) score += 70;
    else if (/^(?:send|submit)$/i.test(label)) score += 60;
    else if (/^start generation$/i.test(label)) score += 40;
    score += Math.max(0, 40 - distanceBetween(near, button.element) / 20);
    return score;
}

function isGenerationSubmitButton(label: string, element: HTMLElement): boolean {
    const normalized = normalizeLabel(label);
    if (/^(?:generate(?:\s+(?:image|images))?|start generation|create|submit|send|arrow_forward)$/i.test(normalized)) {
        return true;
    }
    return buttonHasSubmitIcon(element);
}

function buttonHasSubmitIcon(element: HTMLElement): boolean {
    const iconText = [
        element.textContent || "",
        ...Array.from(element.querySelectorAll("i, span, svg, [class*='google-symbols'], [class*='material']"))
            .map((node) => node.textContent || "")
    ].join(" ");
    return /(?:^|\s)(?:arrow_forward|send|arrow_upward)(?:\s|$)/i.test(normalizeLabel(iconText));
}

function isButtonEnabled(element: HTMLButtonElement): boolean {
    return !element.disabled &&
        element.getAttribute("aria-disabled") !== "true" &&
        element.getAttribute("data-disabled") !== "true";
}

function normalizeLabel(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function distanceBetween(left: Element, right: Element): number {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    const dx = (a.left + a.width / 2) - (b.left + b.width / 2);
    const dy = (a.top + a.height / 2) - (b.top + b.height / 2);
    return Math.hypot(dx, dy);
}

function listCandidateImages(): Array<{ src: string; width: number; height: number }> {
    return Array.from(document.images)
        .filter((image) =>
            isVisible(image) &&
            image.complete &&
            image.naturalWidth >= 256 &&
            image.naturalHeight >= 256 &&
            /^https:\/\//i.test(image.currentSrc)
        )
        .map((image) => ({
            src: image.currentSrc,
            width: image.naturalWidth,
            height: image.naturalHeight
        }));
}

function hasGenerationBusyIndicator(): boolean {
    const visibleBusyElements = Array.from(document.querySelectorAll<HTMLElement>(
        '[aria-busy="true"], [role="progressbar"], [data-state="loading"], [class*="spinner"], [class*="loading"]'
    )).some(isVisible);
    const generationControls = findButtons().filter(({ label }) =>
        /cancel generation|stop generating|generation in progress|generating/i.test(label)
    );
    return visibleBusyElements || generationControls.length > 0;
}

async function writePromptTrusted(
    element: HTMLElement,
    prompt: string
): Promise<{ ok: true } | { ok: false; message: string }> {
    // Prefer DOM writing so Start batch does not hang on debugger attach.
    // Debugger is reserved for the submit click, which Flow often ignores when untrusted.
    for (let attempt = 0; attempt < 3; attempt++) {
        element.focus();
        writePromptDomFallback(element, prompt);
        await delay(200);
        if (promptFieldMatches(element, prompt)) return { ok: true };
    }

    // Last resort: one CDP insert attempt (may flash the debugging bar briefly).
    const focusResult = await trustedClickElement(element);
    if (!focusResult.ok) return focusResult;
    const inserted = await sendTrustedInsertText(prompt);
    if (!inserted.ok) return inserted;
    await delay(250);
    if (promptFieldMatches(element, prompt)) return { ok: true };

    return {
        ok: false,
        message: "Could not write the prompt into Flow's editor. Reload the Flow tab and retry."
    };
}

function promptFieldMatches(element: HTMLElement, prompt: string): boolean {
    const current = normalizeLabel(readPromptField(element));
    const expected = normalizeLabel(prompt);
    return current === expected || current.includes(expected);
}

function writePromptDomFallback(element: HTMLElement, prompt: string): void {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        const prototype = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        setter?.call(element, prompt);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
    }

    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    document.execCommand("insertText", false, prompt);
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

function elementCenter(element: HTMLElement): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return {
        x: rect.left + Math.min(Math.max(rect.width / 2, 2), rect.width - 2),
        y: rect.top + Math.min(Math.max(rect.height / 2, 2), rect.height - 2)
    };
}

async function trustedClickElement(
    element: HTMLElement
): Promise<{ ok: true } | { ok: false; message: string }> {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    await delay(50);
    const { x, y } = elementCenter(element);
    return sendBackgroundMessage({ type: "TRUSTED_CLICK", x, y });
}

async function sendTrustedKey(
    key: "Enter" | "A",
    modifiers?: number
): Promise<{ ok: true } | { ok: false; message: string }> {
    return sendBackgroundMessage({ type: "TRUSTED_KEY", key, modifiers });
}

async function sendTrustedInsertText(
    text: string
): Promise<{ ok: true } | { ok: false; message: string }> {
    return sendBackgroundMessage({ type: "TRUSTED_INSERT_TEXT", text });
}

async function sendBackgroundMessage(
    message: { type: "TRUSTED_CLICK"; x: number; y: number } |
        { type: "TRUSTED_KEY"; key: "Enter" | "A"; modifiers?: number } |
        { type: "TRUSTED_INSERT_TEXT"; text: string }
): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
        const response = await chrome.runtime.sendMessage(message) as BackgroundReply | undefined;
        if (!response || typeof response !== "object" || !("ok" in response)) {
            return { ok: false, message: "Chrome did not confirm the trusted Flow input command." };
        }
        if (response.ok === true) return { ok: true };
        return {
            ok: false,
            message: "message" in response && typeof response.message === "string"
                ? response.message
                : "Trusted Flow input failed."
        };
    } catch (error) {
        return {
            ok: false,
            message: `Trusted Flow input failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

async function requestDownload(
    src: string,
    promptId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
        const response: unknown = await chrome.runtime.sendMessage({
            type: "DOWNLOAD_IMAGE",
            src,
            promptNumber: Number(promptId.match(/\d+$/)?.[0] ?? 0)
        });
        if (typeof response !== "object" || response === null || !("ok" in response)) {
            return { ok: false, message: "Chrome did not confirm the image download." };
        }
        if (response.ok === true) return { ok: true };
        return {
            ok: false,
            message: "message" in response && typeof response.message === "string"
                ? response.message
                : "Chrome could not download the Flow image."
        };
    } catch (error) {
        return {
            ok: false,
            message: `Image download failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

async function failPrompt(stateKey: string, promptId: string, message: string): Promise<void> {
    await updateState(stateKey, (state) => {
        const prompt = state.prompts.find((item) => item.id === promptId);
        if (prompt) {
            prompt.status = "failed";
            prompt.error = message;
            prompt.baselineImageSources = undefined;
        }
        state.activePromptId = null;
        state.status = "paused";
        state.message = message;
    });
}

async function handleBatchError(stateKey: string, error: unknown): Promise<void> {
    const message = `Automatic batch stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message, error);
    try {
        await updateState(stateKey, (state) => {
            const active = state.prompts.find((prompt) => prompt.id === state.activePromptId);
            if (active) {
                active.status = "failed";
                active.error = message;
                active.baselineImageSources = undefined;
            }
            state.activePromptId = null;
            state.status = "paused";
            state.message = message;
        });
    } catch (storageError) {
        console.error("Could not save the automatic batch error:", storageError);
    }
}

function isExtensionContextInvalidated(error: unknown): boolean {
    return error instanceof Error && /extension context invalidated/i.test(error.message);
}

async function readState(stateKey: string): Promise<BatchState | undefined> {
    const stored = (await chrome.storage.local.get(stateKey))[stateKey] as BatchState | undefined;
    return stored && Array.isArray(stored.prompts) ? stored : undefined;
}

async function updateState(
    stateKey: string,
    update: (state: BatchState) => void
): Promise<void> {
    const state = await readState(stateKey);
    if (!state) return;
    update(state);
    await chrome.storage.local.set({ [stateKey]: state });
}

function isFlowRequest(value: unknown): value is FlowRequest {
    return typeof value === "object" && value !== null &&
        "type" in value && value.type === "START_BATCH" &&
        "stateKey" in value && typeof value.stateKey === "string";
}

function isVisible(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) !== 0;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
