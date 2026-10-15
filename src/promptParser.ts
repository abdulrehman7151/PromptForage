const PROMPT_START_PATTERN =
    /^\s*(?:\d{1,4}\s*[.)]|prompt\s*\d{1,4}\s*[:.)-])\s*/i;

export function groupLinesIntoPrompts(lines: string[]): string[] {
    const prompts: string[] = [];
    let currentPrompt = "";
    let currentPromptNumber: number | undefined;

    for (const line of lines) {
        const startMatch = line.match(PROMPT_START_PATTERN);
        let remaining = line;

        if (startMatch) {
            if (currentPrompt.trim()) {
                prompts.push(currentPrompt.trim());
            }
            currentPrompt = "";
            currentPromptNumber = parsePromptNumber(startMatch[0]);
            remaining = line.slice(startMatch[0].length);
        } else if (currentPrompt) {
            remaining = line;
        } else {
            continue;
        }

        const inlineStarts = /\s+(?:prompt\s*(\d{1,4})\s*[:.)-]|\d{1,4}\s*[.)])\s*/ig;
        let cursor = 0;
        let match: RegExpExecArray | null;

        while ((match = inlineStarts.exec(remaining)) !== null) {
            const nextNumber = parsePromptNumber(match[0]);
            if (currentPromptNumber === undefined || nextNumber !== currentPromptNumber + 1) {
                continue;
            }

            currentPrompt = appendText(currentPrompt, remaining.slice(cursor, match.index));
            if (currentPrompt) prompts.push(currentPrompt);
            currentPrompt = "";
            currentPromptNumber = nextNumber;
            cursor = match.index + match[0].length;
        }

        currentPrompt = appendText(currentPrompt, remaining.slice(cursor));
    }

    if (currentPrompt.trim()) {
        prompts.push(currentPrompt.trim());
    }

    return prompts;
}

function parsePromptNumber(marker: string): number | undefined {
    const number = marker.match(/\d{1,4}/)?.[0];
    return number ? Number(number) : undefined;
}

function appendText(current: string, next: string): string {
    const text = next.trim();
    return text ? [current.trim(), text].filter(Boolean).join(" ") : current;
}
