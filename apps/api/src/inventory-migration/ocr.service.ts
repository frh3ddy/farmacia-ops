import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createEngine, type OcrEngine } from '@arcships/light-ocr';

/**
 * Lazy, request-time OCR for Product.squareImageUrl (offline PP-OCRv6, no
 * API calls) — the engine loads its native model once on first use and is
 * reused for the process lifetime, same idea as a DB connection pool.
 * Callers are expected to persist the result onto Product.ocrText themselves
 * so the same image is never OCR'd twice; this service holds no cache.
 */
@Injectable()
export class OcrService implements OnModuleDestroy {
  private enginePromise: Promise<OcrEngine> | null = null;

  private getEngine(): Promise<OcrEngine> {
    if (!this.enginePromise) this.enginePromise = createEngine();
    return this.enginePromise;
  }

  /** Returns recognized text, or null on any failure (network, decode,
   * inference) — OCR is a best-effort signal with a name-based fallback
   * everywhere it's used, never a hard dependency. */
  async recognizeImageUrl(url: string): Promise<string | null> {
    try {
      const engine = await this.getEngine();
      const res = await fetch(url);
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      const result = await engine.recognizeEncoded(bytes);
      return result.lines.map((l) => l.text).join('\n');
    } catch {
      return null;
    }
  }

  async onModuleDestroy() {
    if (this.enginePromise) {
      const engine = await this.enginePromise;
      await engine.close();
    }
  }
}
