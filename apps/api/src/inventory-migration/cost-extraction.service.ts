import { Injectable } from '@nestjs/common';
import {
  CostExtractionResult,
  ExtractedCostEntry,
} from './types';

// 1. Centralize the Month/Typo Map (Moved outside class for performance)
// Key: The exact match (including typos) found in text
// Value: The standardized English month name
const MONTH_MAP: Record<string, string> = {
  // Enero
  enero: 'January', ene: 'January', enro: 'January', ennero: 'January',
  // Febrero
  febrero: 'February', feb: 'February', febreo: 'February', febero: 'February', febre: 'February',
  // Marzo
  marzo: 'March', marso: 'March', marozo: 'March',
  // Abril
  abril: 'April', abil: 'April', abirl: 'April', abri: 'April',
  // Mayo
  mayo: 'May', maio: 'May', may: 'May',
  // Junio
  junio: 'June', jun: 'June', junior: 'June', juno: 'June', junnio: 'June',
  // Julio
  julio: 'July', jul: 'July', julho: 'July', jullio: 'July', juliyo: 'July',
  // Agosto
  agosto: 'August', ago: 'August', agsto: 'August', agost: 'August', agoto: 'August',
  // Septiembre
  septiembre: 'September', sept: 'September', sep: 'September', setiembre: 'September', 
  septiempre: 'September', septimbre: 'September', setimbre: 'September', 
  setiempre: 'September', setimpre: 'September', septimpre: 'September',
  // Octubre
  octubre: 'October', oct: 'October', otubre: 'October', octubr: 'October',
  // Noviembre
  noviembre: 'November', nov: 'November', noviempre: 'November', novimbre: 'November', 
  noviemre: 'November', novimpre: 'November', novimre: 'November',
  // Diciembre
  diciembre: 'December', dic: 'December', dicimbre: 'December', dicimpre: 'December', dicimre: 'December',
};

// 2. Generate Regex from Map Keys automatically
// Sort by length (descending) to match "Septiembre" before "Sep"
const SORTED_KEYS = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length);
const MONTH_REGEX_STRING = `(${SORTED_KEYS.join('|')})`;

@Injectable()
export class CostExtractionService {
  // 3. Pre-compile Regex Patterns (Static for memory efficiency)
  private static readonly EXCLUSION_PATTERNS = [
    /^Fórmula:/i,
    /^Descripción:/i,
    /^Laboratorio:/i,
    /^Costo\s/i,
    /^\d+$/,
  ];

  // Matches: (Supplier text) $ (Amount)
  private static readonly SUPPLIER_REGEX = /([A-Za-z0-9][A-Za-z0-9\s'.-]{0,15})\s*[\$💲]/;
  private static readonly AMOUNT_REGEX = /[\$💲]\s*(\d+[.,]?\d*)/;
  private static readonly MONTH_REGEX = new RegExp(MONTH_REGEX_STRING, 'i');
  // Matches MM/DD/YYYY or MM-DD-YYYY at start of line
  private static readonly DATE_PREFIX_REGEX = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+/;

  extractCostFromDescription(
    productName: string,
    productDescription?: string | null,
  ): Omit<CostExtractionResult, 'productId' | 'productName' | 'originalDescription'> {
    const result: Omit<
      CostExtractionResult,
      'productId' | 'productName' | 'originalDescription'
    > = {
      extractedEntries: [],
      extractionErrors: [],
      requiresManualReview: false,
      selectedCost: null,
    };

    const combinedText = [productName, productDescription]
      .filter((t) => t && t.trim().length > 0)
      .join('\n');

    if (!combinedText.trim()) {
      result.extractionErrors.push('Product name and description are empty');
      return result;
    }

    let lines = combinedText.split(/\r?\n/);

    // Merge month-only lines (e.g. "mayo" on its own line) with the previous cost line
    // Format: "Ba $20.00\nmayo" -> "Ba $20.00 mayo"
    const MONTH_ONLY_REGEX = new RegExp(`^\\s*((?:\\d{1,2}\\s+)?(?:${SORTED_KEYS.join('|')})|(?:${SORTED_KEYS.join('|')})\\s*(?:\\d{1,2})?)\\s*$`, 'i');
    const mergedLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const hasCurrency = line.includes('$') || line.includes('💲');
      if (hasCurrency) {
        mergedLines.push(line);
      } else if (mergedLines.length > 0 && MONTH_ONLY_REGEX.test(line)) {
        mergedLines[mergedLines.length - 1] = `${mergedLines[mergedLines.length - 1]} ${line}`;
      }
    }
    lines = mergedLines;

    let lineNumber = 0;
    for (const rawLine of lines) {
      lineNumber++;
      const line = rawLine.trim();
      if (!line) continue;

      // Fast fail: check exclusions
      if (CostExtractionService.EXCLUSION_PATTERNS.some((p) => p.test(line))) {
        continue;
      }

      // Fast fail: must contain currency symbol
      if (!line.includes('$') && !line.includes('💲')) {
        continue;
      }

      // 1. Extract Amount
      const amountMatch = line.match(CostExtractionService.AMOUNT_REGEX);
      if (!amountMatch) continue;

      const rawAmount = amountMatch[1].replace(',', '.');
      const amount = parseFloat(rawAmount);

      // Sanity check
      if (isNaN(amount) || amount < 0 || amount > 10000) continue;

      // 2. Check for date prefix (MM/DD/YYYY or MM-DD-YYYY) at start of line
      const datePrefixMatch = line.match(CostExtractionService.DATE_PREFIX_REGEX);
      const lineForSupplier = datePrefixMatch ? line.slice(datePrefixMatch[0].length) : line;

      // 3. Extract Supplier (use line without date prefix if present)
      let supplier = 'General';
      const supplierMatch = lineForSupplier.match(CostExtractionService.SUPPLIER_REGEX);
      
      if (supplierMatch) {
        supplier = supplierMatch[1].trim();
      } else {
        const dollarIndex = lineForSupplier.search(/[\$💲]/);
        if (dollarIndex > 0) {
          const prefix = lineForSupplier.substring(0, dollarIndex).trim();
          // Heuristic: If prefix is short (<= 3 words, <= 15 chars), it's likely a code/supplier
          // If it's long, it's likely the product name, so we default to "General"
          const words = prefix.split(/\s+/);
          if (prefix.length <= 15 && words.length <= 3) {
             supplier = prefix;
          }
        }
      }

      // 4. Extract Month, Day, Year
      let month: string | null = null;
      let day: number | null = null;
      let extractedYear: number | null = null;

      if (datePrefixMatch) {
        const monthNum = parseInt(datePrefixMatch[1], 10);
        const dayNum = parseInt(datePrefixMatch[2], 10);
        const yearNum = parseInt(datePrefixMatch[3], 10);
        if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31 && yearNum >= 1900 && yearNum <= 2100) {
          const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
          month = MONTH_NAMES[monthNum - 1];
          day = dayNum;
          extractedYear = yearNum;
        }
      }

      if (!month) {
        const monthMatch = line.match(CostExtractionService.MONTH_REGEX);
        const monthRaw = monthMatch ? monthMatch[1].toLowerCase() : null;
        month = monthRaw ? MONTH_MAP[monthRaw] : null;
      }

      // 5. Extract Day (when month from month name, not date prefix)
      // Patterns: "1 mar", "10 ene", "3 dec" (day before month) or "mar 1", "ene 10" (month before day)
      if (day === null && month) {
        const monthMatch = line.match(CostExtractionService.MONTH_REGEX);
        if (monthMatch) {
          const monthStart = monthMatch.index!;
          const monthEnd = monthStart + monthMatch[0].length;
          // Day before month: (\d{1,2})\s+ immediately before month (avoid matching amount like 22.00)
          const dayBeforeMatch = line.slice(0, monthStart).match(/(\d{1,2})\s*$/);
          if (dayBeforeMatch) {
            const d = parseInt(dayBeforeMatch[1], 10);
            if (d >= 1 && d <= 31) day = d;
          }
          // Day after month: \s+(\d{1,2}) immediately after month
          if (day === null) {
            const dayAfterMatch = line.slice(monthEnd).match(/^\s*(\d{1,2})\b/);
            if (dayAfterMatch) {
              const d = parseInt(dayAfterMatch[1], 10);
              if (d >= 1 && d <= 31) day = d;
            }
          }
        }
      }

      // 6. Determine Confidence
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
      if (!month) confidence = 'MEDIUM';
      if (supplier === 'General') confidence = 'MEDIUM'; 
      // Downgrade to LOW if we found an amount but neither month nor supplier
      if (!month && supplier === 'General') confidence = 'LOW';

      result.extractedEntries.push({
        supplier,
        amount,
        month,
        day: day ?? undefined,
        extractedYear: extractedYear ?? undefined,
        lineNumber,
        originalLine: line,
        confidence,
      });
    }

    // Post-processing logic
    if (result.extractedEntries.length === 0) {
      result.requiresManualReview = true;
      result.extractionErrors.push('No cost entries extracted');
    } else if (result.extractedEntries.length > 1) {
      result.requiresManualReview = true; // Ambiguity requires human eye
      // Default to the last entry (often the most recent in chronologically appended logs)
      result.selectedCost = result.extractedEntries[result.extractedEntries.length - 1].amount;
    } else {
      // Single entry
      const entry = result.extractedEntries[0];
      result.selectedCost = entry.amount;
      if (entry.confidence === 'LOW') result.requiresManualReview = true;
    }

    return result;
  }
}