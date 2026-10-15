import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { groupLinesIntoPrompts } from "./promptParser.js";

export { groupLinesIntoPrompts } from "./promptParser.js";

const PDF_PATH = path.resolve("pdfs/prompts.pdf");

export async function readPdfPrompts(): Promise<string[]> {
    const lines = await extractLinesFromPdf(PDF_PATH);
    const prompts = groupLinesIntoPrompts(lines);

    if (prompts.length === 0) {
        throw new Error(
            "No numbered prompts found. Check the PDF's numbering format."
        );
    }

    return prompts;
}

async function extractLinesFromPdf(pdfPath: string): Promise<string[]> {
    const fileBuffer = await readFile(pdfPath);

    const loadingTask = getDocument({ data: new Uint8Array(fileBuffer) });
    const pdf = await loadingTask.promise;

    const lines: string[] = [];

    try {
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);

            try {
                const content = await page.getTextContent();
                collectLinesFromPage(content.items, lines);
            } finally {
                await page.cleanup();
            }
        }
    } finally {
        await loadingTask.destroy();
    }

    return lines;
}

function collectLinesFromPage(
    items: Array<unknown>,
    lines: string[]
): void {
    let currentLine = "";
    let previousY: number | undefined;

    for (const item of items) {
        if (!isTextItem(item)) {
            continue;
        }

        const { str, y } = item;

        const movedToNewLine =
            previousY !== undefined && Math.abs(y - previousY) > 3;

        if (movedToNewLine) {
            if (currentLine.trim()) {
                lines.push(currentLine.trim());
            }
            currentLine = "";
        }

        currentLine += str + " ";
        previousY = y;
    }

    if (currentLine.trim()) {
        lines.push(currentLine.trim());
    }
}

function isTextItem(
    item: unknown
): item is { str: string; y: number } {
    if (typeof item !== "object" || item === null) {
        return false;
    }

    const candidate = item as { str?: unknown; transform?: unknown };

    return (
        typeof candidate.str === "string" &&
        Array.isArray(candidate.transform) &&
        typeof candidate.transform[5] === "number"
    );
}
