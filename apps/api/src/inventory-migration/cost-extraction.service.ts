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

    // Regex patterns
    const providerPattern = /^([A-Za-z][A-Za-z0-9\s'.-]{0,19})\s*[\$💲]/;
    const amountPattern = /[\$💲]\s*(\d+\.?\d*)/;
    const monthPattern =
      /(enero|febrero|feb|marzo|abril|mayo|junio|jun|julio|jul|agosto|ago|septiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)/i;

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

      // Extract provider
      const providerMatch = line.match(providerPattern);
      if (!providerMatch) {
        continue; // Not a cost entry line
      }
      const provider = providerMatch[1].trim();

      // Extract amount
      const amountMatch = line.match(amountPattern);
      if (!amountMatch) {
        result.extractionErrors.push(
          `Line ${lineNumber}: Could not extract amount from "${line}"`,
        );
        continue;
      }
      const amountString = amountMatch[1];
      const amount = parseFloat(amountString);

      if (isNaN(amount) || amount < 0) {
        result.extractionErrors.push(
          `Line ${lineNumber}: Invalid amount "${amountString}"`,
        );
        continue;
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
      if (amount <= 0 || amount > 10000) {
        confidence = 'LOW'; // Suspicious amount
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



