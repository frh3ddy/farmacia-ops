/**
 * Local-only. Runs Claude Haiku over the catalog OCR dump
 * (data/catalog-ocr-text.json) to extract structured medicine data
 * (esMedicamento, brand, laboratorio, active ingredient, concentration, form,
 * presentation) from each product's box text + Square name.
 *
 * Calls the `claude` CLI in --print mode, ~BATCH rows per call, so the fixed
 * per-invocation overhead is amortised. Resumable: results are keyed by
 * squareItemId and a re-run skips ids already present in the output file.
 * Checkpoints after every batch, so a quota cutoff just means resume later.
 *
 * Only rows with non-empty ocrText are processed (~3,031 of 4,042).
 *
 * Usage:
 *   npx tsx scripts/extract-medicine-from-ocr.ts
 *   BATCH=30 LIMIT=2 npx tsx scripts/extract-medicine-from-ocr.ts   # smoke test
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const IN_PATH = path.resolve(__dirname, '../data/catalog-ocr-text.json');
const OUT_PATH = path.resolve(__dirname, '../data/catalog-medicine-extract.json');
const MODEL = 'claude-haiku-4-5';
const BATCH = parseInt(process.env.BATCH ?? '50', 10);
const CALL_TIMEOUT_MS = 240_000;

interface OcrRow {
  squareItemId: string;
  name: string;
  ocrText: string | null;
}
interface Extract {
  esMedicamento: boolean;
  confianza: 'alta' | 'media' | 'baja';
  nombreComercial: string | null;
  laboratorio: string | null;
  principioActivo: string | null;
  concentracion: string | null;
  formaFarmaceutica: string | null;
  presentacion: string | null;
  notas: string | null;
}

const PROMPT_HEADER = `You extract structured product data from noisy pharmacy-shelf OCR text (Spanish, Mexico). Each input has an id, the Square catalog name, and OCR text from the product photo (may be garbled or contain text bleeding from neighboring products).

For EACH input object output exactly one result object. Return ONLY a JSON array, same length and order as the input. No prose, no markdown fences.

Result shape:
{"id":"<echo input id>","esMedicamento":bool,"confianza":"alta"|"media"|"baja","nombreComercial":str|null,"laboratorio":str|null,"principioActivo":str|null,"concentracion":str|null,"formaFarmaceutica":str|null,"presentacion":str|null,"notas":str|null}

Rules:
- Use BOTH the name and the OCR text. The name often carries the brand «» generic; the OCR often carries the ingredient/dose the name lacks.
- esMedicamento: true only if a principioActivo, concentracion, or formaFarmaceutica is present, OR the brand is an unambiguous medicine; otherwise false (cosmetics, supplements, hygiene, devices, snacks, phone credit, etc.).
- laboratorio vs nombreComercial: "Laboratorios X", "Farmacéutica X", or a bare ALL-CAPS maker token (BIOMEP, RANDALL, PISA, SONS, MAVER...) is the laboratorio, NOT the brand. A generic with no marketing brand => nombreComercial null, laboratorio set.
- Combinaciones: join active ingredients with " + " in principioActivo. Keep the concentration separator as printed ("/", "-").
- Do not invent data absent from name+OCR. Ignore unreadable noise and text from other products.

INPUT:
`;

function callClaude(rows: Array<{ id: string; name: string; ocrText: string }>): Extract[] | null {
  const input = JSON.stringify(rows);
  let raw: string;
  try {
    raw = execFileSync('claude', ['-p', '--model', MODEL], {
      input: PROMPT_HEADER + input,
      encoding: 'utf-8',
      timeout: CALL_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`  claude call failed: ${(e as Error).message.split('\n')[0]}`);
    return null;
  }
  // Strip optional ```json ... ``` fences and any leading prose.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    console.error(`  no JSON array in response (${raw.length} chars)`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error(`  JSON parse failed: ${(e as Error).message}`);
    return null;
  }
}

function processBatch(
  batch: OcrRow[],
  results: Record<string, Extract>,
): number {
  const rows = batch.map((r) => ({ id: r.squareItemId, name: r.name, ocrText: r.ocrText!.slice(0, 2000) }));
  let out = callClaude(rows);

  // One retry at half size on failure.
  if (!out || out.length < rows.length * 0.8) {
    const mid = Math.ceil(rows.length / 2);
    const a = callClaude(rows.slice(0, mid));
    const b = callClaude(rows.slice(mid));
    out = [...(a ?? []), ...(b ?? [])];
  }

  let written = 0;
  const byId = new Map(out.map((o: any) => [o.id, o]));
  for (const r of batch) {
    const o = byId.get(r.squareItemId);
    if (!o || typeof o.esMedicamento !== 'boolean') continue;
    delete o.id;
    results[r.squareItemId] = o as Extract;
    written++;
  }
  return written;
}

async function main() {
  const all: OcrRow[] = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
  const results: Record<string, Extract> = fs.existsSync(OUT_PATH)
    ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'))
    : {};
  const before = Object.keys(results).length;

  let todo = all.filter((r) => r.ocrText && r.ocrText.trim() && !(r.squareItemId in results));
  if (process.env.LIMIT) todo = todo.slice(0, parseInt(process.env.LIMIT, 10) * BATCH);

  const totalWithText = all.filter((r) => r.ocrText && r.ocrText.trim()).length;
  console.log(`${todo.length} rows to extract (${before}/${totalWithText} already done), BATCH=${BATCH}, model ${MODEL}\n`);

  const batches = Math.ceil(todo.length / BATCH);
  let done = 0;
  let consecutiveFails = 0;
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const n = processBatch(batch, results);
    done += n;
    fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2) + '\n');
    const b = i / BATCH + 1;
    const rate = done / ((Date.now() - t0) / 1000);
    console.log(
      `  batch ${b}/${batches}: +${n}/${batch.length}  (total ${Object.keys(results).length}, ${rate.toFixed(1)} rows/s)`,
    );
    consecutiveFails = n === 0 ? consecutiveFails + 1 : 0;
    if (consecutiveFails >= 3) {
      console.log(`\n3 batches in a row produced nothing (quota/rate limit?). Stopping — re-run to resume from the checkpoint.`);
      break;
    }
  }

  const final = Object.values(results);
  const meds = final.filter((x) => x.esMedicamento).length;
  console.log(`\nDone. ${final.length} rows extracted (+${final.length - before} this run).`);
  console.log(`  esMedicamento: ${meds}   otros: ${final.length - meds}`);
  console.log(`  ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
