# PromptForage

PromptForage is a local-first TypeScript project that reads numbered prompts
from a PDF and sends them to Google Flow from a Chrome Manifest V3 extension.
The extension can submit prompts sequentially, wait for new image candidates,
download them, and save progress between prompts.

> **Prototype limitation:** Google Flow's completion and page controls are not
> verified against an authenticated project. PromptForage uses a best-effort
> heuristic: after submission it waits for new visible images, waits for common
> loading indicators to disappear and the image list to remain quiet, then
> downloads the detected images. This can time out or misidentify images if
> Flow changes its interface. Test with a small batch and supervise it.

## Quick start

From the `promptforage` directory, build the unpacked extension:

```powershell
npm install
npm run build:extension
```

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `promptforage/extension-dist`.
4. Open Google Flow in another tab, sign in normally, and open a project.
5. Open PromptForage, select a text-based PDF with numbered prompts, and
   review/edit the extracted prompts.
6. Click **Start batch**. Keep the Google Flow tab open while the batch runs.
7. Watch the status in the extension popup. PromptForage submits one prompt,
   waits for the generated image(s), downloads them, waits for Chrome to finish
   the downloads, and then advances to the next pending prompt.

Chrome saves files under its configured Downloads location, in the
`PromptForage` subfolder. On Windows this is commonly
`C:\Users\<your-name>\Downloads\PromptForage`. Chrome controls the actual
Downloads location; the extension cannot choose or write to an arbitrary path
such as this repository's `generated/` directory.

If you change extension source files, rebuild with `npm run build:extension`,
then reload PromptForage at `chrome://extensions`. The popup can inject the
current Flow content script on demand; if Chrome still cannot connect, reload
the Flow tab and retry.

## How it works

```text
PDF selected in popup
  -> PDF.js reads text locally
  -> shared parser builds numbered, editable prompts
  -> chrome.storage.local saves prompts and progress
  -> popup tells the Flow tab to start/resume
  -> Flow content script submits one prompt
  -> content script watches for new visible images and a quiet page
  -> background service worker downloads image URLs using Chrome Downloads
  -> content script waits for downloads to finish
  -> state is saved and the next prompt is submitted
```

### PDF import and review

PDF.js runs inside the extension and reads the selected file in the browser;
PromptForage does not upload the PDF to a PromptForage server. Prompts are
grouped by numbered markers such as `1.`, `2)`, and `Prompt 3:`. Lines between
markers are joined into the preceding prompt, and consecutive markers on one
PDF text line are split. Review the results because unusual PDF layout,
columns, or numbering can still produce incorrect groupings.

The extension currently needs a PDF with selectable text. Scanned image-only
PDFs require OCR, which is not included.

Use **Change PDF** to replace the loaded prompts with prompts from another PDF.
Use **Remove PDF** to clear the saved prompt list and batch progress. Both
actions ask for confirmation before clearing existing work. Pause a running
batch first; if a prompt is still in progress, its Flow generation may continue
but PromptForage will no longer track or download it.

### Automatic batch

The content script runs the batch in the Google Flow tab, not in the popup.
Closing the popup should not stop a batch as long as the Flow tab stays open.
Batch state is saved to `chrome.storage.local`.

The content script:

1. Records the URLs of visible candidate images before each prompt.
2. Finds a visible prompt-like text field and fills it.
3. Waits for a single visible **Generate**, **Generate image(s)**, or
   **Start generation** button to become enabled, then clicks it. It checks for
   Flow's submission acknowledgment by re-reading the live button, composer,
   busy state, and image list (Flow may replace DOM elements during submission).
   If the page does not acknowledge the click within 20 seconds, it pauses and
   asks you to inspect Flow rather than silently retrying.
4. Watches for newly visible HTTPS images at least 256 pixels wide and tall.
5. Waits for ten seconds without a newly detected image and for common busy
   indicators to disappear.
6. Asks the background service worker to download the new image candidates.
7. Waits up to three minutes for Chrome to report the downloads completed.
8. Marks the prompt complete and continues.

Image detection waits up to ten minutes of active (not paused) time for a new
image. The quiet period and
loading-indicator checks are heuristics, not proof that Flow has finished.
Pages with changing markup, unrelated new images, invisible download URLs,
canvas-only results, or different loading signals can cause errors or incorrect
detection. A timeout pauses the batch and marks the prompt failed so it will
not be submitted again automatically. Inspect Flow before retrying.

The extension downloads image URLs through Chrome's Downloads API rather than
clicking a Flow page download button. This avoids depending on an unverified
download-button selector. If Flow uses temporary, protected, or non-image URLs,
Chrome may refuse the download; the popup reports failures.

If Flow displays a reCAPTCHA connection or verification error, automation
pauses and reports that blocker. Resolve it in Flow manually and retry only
after checking whether the current prompt was accepted. PromptForage does not
attempt to bypass CAPTCHA or other access controls.

### Progress controls

- **Start batch** — begins at the first pending prompt.
- **Pause** — stops generation detection from timing out while paused. The
  already submitted generation is left alone; resume keeps waiting for it.
- **Resume** — continues an interrupted/paused batch. It will not intentionally
  resubmit a prompt already marked `in_progress`; it continues waiting for that
  prompt's image.
- **Resubmit current** — asks for confirmation, resets the in-progress prompt,
  and sends it to Flow again. Use this only after checking that Flow did not
  accept the earlier submission; otherwise, it could create a duplicate.
- **Stop** — stops advancing and saves progress. Resume may continue waiting
  for the in-progress image.
- **Retry failed** — returns failed prompts to pending and resumes the batch.
  Completed prompts are skipped.

Keep the Flow tab open. If you close or reload the Flow tab while a prompt is
in progress, the extension can no longer observe that page's generation.
Inspect Flow before resuming. The extension saves progress, but cannot promise
exactly-once submission if Chrome or the Flow tab crashes at the instant a
prompt is sent.

Do not reload or disable PromptForage while a batch is running. Chrome
invalidates the Flow content script when an extension is reloaded, and the
current prompt's observer stops. If this happens, check the Flow project first.
Reload the extension and Flow tab, open the popup, click **Pause** if the saved
status still says running, then click **Resume** to continue waiting for an
in-progress prompt. Use **Resubmit current** only if Flow did not accept it;
resubmitting may create a duplicate.

## Saving images

Downloads use names like:

```text
Downloads/
└── PromptForage/
    ├── prompt-001.png
    ├── prompt-002.webp
    └── prompt-003.png
```

The actual image extension is inferred from its URL when possible; otherwise
`.png` is used. Chrome uses a unique filename if a file already exists, so
retries will not silently overwrite earlier images. If Chrome is configured
to ask where to save every file, it may still display a save dialog.

The Chrome extension Downloads API only writes inside Chrome's configured
Downloads area. To write to an arbitrary folder or directly into this
repository's `generated/` directory, the project would need a separately
installed local companion application with explicit filesystem permissions.
That helper is not included.

## Project structure

| File/folder | Purpose |
| --- | --- |
| `src/index.ts` | CLI entry point for the original PDF prototype. |
| `src/readPdf.ts` | Node.js PDF extraction from `pdfs/prompts.pdf`. |
| `src/promptParser.ts` | Shared numbered/multiline prompt parser. |
| `src/promptParser.test.ts` | Prompt parser tests. |
| `src/automateFlow.ts` | Separate Playwright helper for manual Flow inspection/login. Playwright is not run inside the extension. |
| `extension/manifest.json` | Extension manifest, permissions, popup, background worker and Flow URL matches. |
| `extension/popup.html` / `extension/popup.css` | Extension popup interface and styling. |
| `extension/popup.ts` | PDF import, prompt review, batch controls, and persisted progress. |
| `extension/content.ts` | Runs in the Flow tab: submits prompts, observes image candidates, and requests downloads. |
| `extension/background.ts` | Uses Chrome Downloads API and waits for download completion. |
| `extension/protocol.ts` | Shared TypeScript extension message and state types. |
| `extension/tsconfig.json` | Browser TypeScript configuration. |
| `scripts/build-extension.mjs` | Bundles TypeScript and copies PDF.js runtime files and extension assets. |
| `pdfs/prompts.pdf` | Sample PDF for the original CLI prototype. |
| `generated/` | Existing project folder; the extension does not currently save directly here. |
| `extension-dist/` | Generated unpacked extension; rebuild rather than editing it manually. |

## Commands

Run these from the project directory:

| Command | Description |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm run build:extension` | Type-check and build the unpacked Chrome extension. |
| `npm run typecheck:extension` | Check the extension TypeScript without building. |
| `npm test` | Run prompt parser tests. |
| `npm run dev` | Run the CLI against `pdfs/prompts.pdf`. |
| `npm run build` | Compile the Node.js TypeScript prototype. |
| `npm start` | Run the compiled CLI after `npm run build`. |

## Troubleshooting

### The extension does not load

- Make sure **Load unpacked** points to `promptforage/extension-dist`, not
  `extension/`.
- Run `npm run build:extension` and reload the extension card in
  `chrome://extensions`.
- Read the error shown on the extension card.
- PromptForage injects its Flow script when it cannot find one. If that still
  fails, reload the Flow tab after reloading the extension.
- If the popup reports an outdated or incompatible Flow script, reload
  PromptForage from `chrome://extensions`, then reload the Flow tab and retry.
- Make sure the Flow tab is an actual project/editor with its prompt field
  visible, not just the Flow information/about page.

### The batch cannot submit a prompt

- Open a supported Google Flow project in a normal browser tab.
- Sign in manually if necessary.
- Reload the Flow tab after installing/reloading the extension.
- Keep the prompt composer visible. PromptForage pauses rather than selecting
an ambiguous field or generation button.
- Review the popup's status message. If Flow changed its labels or layout,
  inspect the new page and update `extension/content.ts` to match observed
  accessible labels; do not guess selectors.

### The batch waits but finds no image

- Confirm Flow actually accepted the prompt and generated an image.
- Check that the result is a visible image element with a directly downloadable
  HTTPS URL. Results rendered only in a canvas or behind an inaccessible URL
  are not supported by the current detector.
- If Flow changed its loading UI, update and test the busy-indicator detection
  in `extension/content.ts`.
- A timed-out prompt is marked failed and is not automatically resubmitted.
  Inspect Flow before using **Retry failed**.

### The download fails or is saved elsewhere

- Open Chrome's Downloads page and inspect the failed download message.
- Check Chrome's configured Downloads directory and any **Ask where to save
  each file** setting.
- The expected folder is `PromptForage` under that configured directory.
- The extension cannot write to an arbitrary project folder such as
  `generated/`.

### The CLI finds no prompts

- `npm run dev` reads `pdfs/prompts.pdf`; it does not read a PDF selected in
  the extension.
- Ensure the PDF contains selectable text and numbered prompt markers.
- Scanned PDFs need OCR, which is not included.

## How to continue and make it real-world reliable

1. **Test with supervision.** Start with a tiny PDF and one prompt. Confirm the
   prompt field, Generate button, generated image detection, downloaded file,
   and destination folder in Chrome. Do not start with a large batch.
2. **Capture real Flow behavior.** Record the actual page URL, visible prompt
   field labels, Generate button labels, busy states, and how generated images
   appear. Flow is not verified against an authenticated project in this
   prototype.
3. **Make detection exact.** Update the content script using observed,
   accessible page controls. Add tests for field matching, button matching,
   new-image identification, generation timeout, and download failure. Stop
   on ambiguity rather than clicking a guessed control.
4. **Define a reliable completion signal.** The current detector uses new
   images plus a quiet period and common busy indicators. Verify whether Flow
   exposes a stable visible completion/error state. Until then, keep a human
   supervising each run because the page heuristic can advance too soon or
   wait too long.
5. **Test interruption cases.** Pause during generation, close the popup,
   reload the Flow tab, interrupt a download, restart Chrome, and retry a
   failed prompt. Confirm no uncertain prompt is silently resubmitted.
6. **Test image association.** Flow may add thumbnails, previews, or unrelated
   project images. Verify the newly detected URLs belong to the prompt that
   just ran before relying on automatic downloading.
7. **Test clean installations.** Build and load the extension in a clean Chrome
   profile, verify the exact permissions, test supported Flow URLs, and test
   after Flow UI changes.
8. **Publish only after review.** Prepare privacy disclosures, supported-browser
   documentation, permission justification, error handling, and Chrome Web
   Store assets/policies before publishing. The unpacked development build is
   not automatically installed for other users.

## Privacy and responsible use

- PDF extraction occurs in the browser. Prompt and progress data are saved in
  `chrome.storage.local`.
- Google login is handled by Google in Chrome; PromptForage does not ask for
  your password or read Google cookies.
- Generated image downloads are handled by Chrome. This project does not
  upload PDFs or images to a PromptForage server.
- Do not commit private PDFs, generated images, browser profiles, cookies,
  credentials, or tokens.
- Follow Google Flow's current terms, account requirements, quotas, and usage
  policies. Do not bypass authentication, limits, or safety controls.
