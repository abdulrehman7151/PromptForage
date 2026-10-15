
import { readPdfPrompts } from "./readPdf.js";

async function main(): Promise<void> {
    try {
        const prompts = await readPdfPrompts();

        console.log(`Found ${prompts.length} prompts:\n`);

        prompts.forEach((prompt, index) => {
            console.log(`${index + 1}. ${prompt}\n`);
        });
    } catch (error) {
        console.error("PDF reading failed:", error);
    }
}

main();
