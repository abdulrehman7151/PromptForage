import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "extension-dist");
const pdfJsDirectory = path.join(projectRoot, "node_modules", "pdfjs-dist", "legacy", "build");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
    entryPoints: {
        popup: path.join(projectRoot, "extension", "popup.ts"),
        background: path.join(projectRoot, "extension", "background.ts"),
        content: path.join(projectRoot, "extension", "content.ts")
    },
    bundle: true,
    outdir: outputDirectory,
    entryNames: "[name]",
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap: false
});

for (const file of ["manifest.json", "popup.html", "popup.css"]) {
    await copyFile(
        path.join(projectRoot, "extension", file),
        path.join(outputDirectory, file)
    );
}

await copyFile(
    path.join(pdfJsDirectory, "pdf.worker.min.mjs"),
    path.join(outputDirectory, "pdf.worker.min.mjs")
);

for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    await cp(
        path.join(projectRoot, "node_modules", "pdfjs-dist", directory),
        path.join(outputDirectory, directory),
        { recursive: true }
    );
}

console.log(`Built unpacked MV3 extension at ${outputDirectory}`);
