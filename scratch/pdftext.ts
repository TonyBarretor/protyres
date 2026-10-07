import fs from "node:fs";
import { pdfToText } from "../src/lib/ingest/pdf";
const { text } = await pdfToText(fs.readFileSync(process.argv[2]));
console.log(text.split("\n").slice(0, +(process.argv[3] ?? 80)).join("\n"));
