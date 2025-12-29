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
  enero: 'January', enro: 'January', ennero: 'January',
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

    const lines = combinedText.split(/\r?\n/);
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

      // 2. Extract Supplier
      let supplier = 'General';
      
      // Try specific regex first
      const supplierMatch = line.match(CostExtractionService.SUPPLIER_REGEX);
      
      if (supplierMatch) {
        supplier = supplierMatch[1].trim();
      } else {
        // Fallback: Check text before the $
        const dollarIndex = line.search(/[\$💲]/);
        if (dollarIndex > 0) {
          const prefix = line.substring(0, dollarIndex).trim();
          // Heuristic: If prefix is short (<= 3 words, <= 15 chars), it's likely a code/supplier
          // If it's long, it's likely the product name, so we default to "General"
          const words = prefix.split(/\s+/);
          if (prefix.length <= 15 && words.length <= 3) {
             supplier = prefix;
          }
        }
      }

      // 3. Extract Month
      // Since regex is built from keys, if it matches, the key exists.
      const monthMatch = line.match(CostExtractionService.MONTH_REGEX);
      const monthRaw = monthMatch ? monthMatch[1].toLowerCase() : null;
      const month = monthRaw ? MONTH_MAP[monthRaw] : null;

      // 4. Determine Confidence
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
      if (!month) confidence = 'MEDIUM';
      if (supplier === 'General') confidence = 'MEDIUM'; 
      // Downgrade to LOW if we found an amount but neither month nor supplier
      if (!month && supplier === 'General') confidence = 'LOW';

      result.extractedEntries.push({
        supplier,
        amount,
        month,
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