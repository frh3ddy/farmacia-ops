import { Injectable } from '@nestjs/common';
import {
  CostExtractionResult,
  ExtractedCostEntry,
} from './types';

@Injectable()
export class CostExtractionService {
  /**
   * Extract all cost entries from product name/description using comprehensive pattern matching
   */
  extractCostFromDescription(
    productName: string,
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

    if (!productName || productName.trim().length === 0) {
      result.extractionErrors.push('Product name is empty');
      return result;
    }

    // Month name mapping (Spanish)
    const monthMap: Record<string, string> = {
      enero: 'enero',
      febrero: 'febrero',
      feb: 'febrero',
      marzo: 'marzo',
      abril: 'abril',
      mayo: 'mayo',
      junio: 'junio',
      jun: 'junio',
      junior: 'junio',
      julio: 'julio',
      jul: 'julio',
      agosto: 'agosto',
      ago: 'agosto',
      septiembre: 'septiembre',
      sept: 'septiembre',
      sep: 'septiembre',
      octubre: 'octubre',
      oct: 'octubre',
      noviembre: 'noviembre',
      nov: 'noviembre',
      diciembre: 'diciembre',
      dic: 'diciembre',
    };

    // Exclusion patterns (skip these lines)
    const exclusionPatterns = [
      /^Fórmula:/i,
      /^Descripción:/i,
      /^Laboratorio:/i,
      /^Costo\s/i,
      /^\d+$/, // Lines with only numbers
    ];

    // Regex patterns - more flexible to handle various formats
    // Pattern 1: Provider at start, then $ and amount (e.g., "L $ 193 abril")
    // Pattern 2: Provider with optional spaces before $ (e.g., "L$193", "L $193", "Rx $ 190")
    // Pattern 3: Just amount with $ (e.g., "$193 abril")
    // Note: Provider pattern doesn't require ^ anchor - can be anywhere in line
    const providerPattern = /([A-Za-z][A-Za-z0-9\s'.-]{0,19})\s*[\$💲]/;
    const amountPattern = /[\$💲]\s*(\d+[.,]?\d*)/; // Allow comma or dot as decimal separator
    const monthPattern =
      /(enero|febrero|feb|marzo|abril|mayo|junio|jun|julio|jul|agosto|ago|septiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)/i;
    
    // Alternative pattern: Look for $ followed by number anywhere in line
    const simpleAmountPattern = /[\$💲]\s*(\d+[.,]?\d*)/;

    // Step 1: Preprocessing - split by newlines
    const lines = productName
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      result.extractionErrors.push('No valid lines found in product name');
      return result;
    }

    // Step 2: Process each line
    let lineNumber = 0;
    for (const line of lines) {
      lineNumber++;

      // Skip exclusion patterns
      if (exclusionPatterns.some((pattern) => pattern.test(line))) {
        continue;
      }

      // First, check if line contains a dollar sign (indicates potential cost entry)
      const dollarIndex = line.indexOf('$') !== -1 ? line.indexOf('$') : line.indexOf('💲');
      if (dollarIndex === -1) {
        continue; // Skip lines without currency symbol
      }

      // Extract amount - look for $ followed by number
      const amountMatch = line.match(simpleAmountPattern);
      if (!amountMatch) {
        continue; // No amount found, skip this line
      }
      
      let amountString = amountMatch[1];
      // Handle comma as decimal separator (e.g., "193,50" -> "193.50")
      amountString = amountString.replace(',', '.');
      const amount = parseFloat(amountString);

      if (isNaN(amount) || amount < 0 || amount > 10000) {
        continue; // Invalid or suspicious amount, skip
      }

      // Extract provider - look for text before the $ symbol
      let provider = 'Unknown';
      const beforeDollar = line.substring(0, dollarIndex).trim();
      
      // Try strict pattern first (provider at start)
      const providerMatch = line.match(providerPattern);
      if (providerMatch) {
        provider = providerMatch[1].trim();
      } else if (beforeDollar.length > 0) {
        // Extract provider from text before $
        // Look for common provider patterns: single letter, short word, etc.
        const words = beforeDollar.split(/\s+/);
        // Common providers are usually 1-3 words, often starting with capital letter
        if (words.length > 0) {
          // Take first word if it's short (likely provider like "L", "Rx", "Center")
          if (words[0].length <= 20 && /^[A-Za-z]/.test(words[0])) {
            provider = words[0];
          } else if (words.length > 1 && words[0].length + words[1].length <= 20) {
            // Take first two words if combined they're short
            provider = words.slice(0, 2).join(' ');
          } else {
            // Fallback: take first 20 chars
            provider = beforeDollar.substring(0, 20).trim();
          }
        }
      }

      // Extract month (optional)
      const monthMatch = line.match(monthPattern);
      let month: string | null = null;
      if (monthMatch) {
        const monthKey = monthMatch[1].toLowerCase();
        month = monthMap[monthKey] || monthKey;
      }

      // Determine confidence
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
      if (!month) {
        confidence = 'MEDIUM'; // No month, but amount extracted
      }
      if (provider === 'Unknown' || provider.length === 0) {
        confidence = 'MEDIUM'; // No provider identified, but amount is valid
      }

      // Add extracted entry
      result.extractedEntries.push({
        provider: provider,
        amount: amount,
        month: month,
        lineNumber: lineNumber,
        originalLine: line,
        confidence: confidence,
      });
    }

    // Step 3: Determine if manual review needed
    if (result.extractedEntries.length === 0) {
      result.requiresManualReview = true;
      result.extractionErrors.push(
        'No cost entries extracted from product name',
      );
    } else if (result.extractedEntries.length > 1) {
      // Multiple entries - owner should review to select correct one
      result.requiresManualReview = true;
    } else if (result.extractedEntries[0].confidence === 'LOW') {
      result.requiresManualReview = true;
    }

    // Set default selected cost (last entry, typically latest)
    if (result.extractedEntries.length > 0) {
      result.selectedCost =
        result.extractedEntries[result.extractedEntries.length - 1].amount;
    }

    return result;
  }
}



