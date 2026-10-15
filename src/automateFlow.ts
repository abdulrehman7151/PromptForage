import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";

// Where Chrome stores cookies, localStorage, and your Google session.
// Keeping this outside the repo avoids accidental commits of your session.
const USER_DATA_DIR = path.resolve(".playwright-user-data");

// Google Flow URL.
const FLOW_URL = "https://flow.google.com/";

export async function openFlowAndWaitForLogin(): Promise<{
    context: BrowserContext;
    page: Page;
}> {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,           // We want to SEE the browser during Phase 2.
        channel: "chrome",         // Use your installed Chrome, not bundled Chromium.
        viewport: { width: 1400, height: 900 },
        ignoreDefaultArgs: ["--enable-automation", "--no-sandbox"],
    });

    const page = context.pages()[0] ?? (await context.newPage());

    console.log(`Opening ${FLOW_URL} ...`);
    await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });

    console.log("\n--- ACTION REQUIRED ---");
    console.log("1. Log into your Google account in THIS browser window");
    console.log("   (this window uses its own profile, separate from your normal Chrome).");
    console.log("2. Navigate to Google Flow and verify you can see '+ New project'.");
    console.log("3. Open an existing project OR click '+ New project'.");
    console.log("4. Make sure the prompt input box is visible on screen.");
    console.log("When you're ready, come back here and press Enter.");
    console.log("-----------------------\n");

    const rl = readline.createInterface({ input, output });
    await rl.question("Press Enter when the Flow page is ready... ");
    rl.close();

    console.log("Current URL:", page.url());
    console.log("Page title :", await page.title());

    return { context, page };
}

// Allows running this file directly for testing:
//   npx tsx src/automateFlow.ts
const isDirectRun =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
    (async () => {
        const { context } = await openFlowAndWaitForLogin();
        console.log("\nBrowser is open. Close it manually when done.");
        // We intentionally do NOT close it here — you inspect the page first.
        await new Promise(() => { }); // keep process alive
    })().catch((err) => {
        console.error("automateFlow failed:", err);
        process.exit(1);
    });
}
