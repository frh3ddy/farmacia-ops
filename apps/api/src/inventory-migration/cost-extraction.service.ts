import { Injectable } from '@nestjs/common';
import {
  CostExtractionResult,
  ExtractedCostEntry,
} from './types';

@Injectable()
export class CostExtractionService {
  /**
   * Extract all cost entries from product name/description using comprehensive pattern matching
   * Combines product name and description for extraction
   */
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

    // Combine product name and description for extraction
    // Description often contains cost information (e.g., "Ba$13.50")
    const combinedText = [
      productName?.trim() || '',
      productDescription?.trim() || '',
    ]
      .filter((text) => text.length > 0)
      .join('\n');

    if (!combinedText || combinedText.trim().length === 0) {
      result.extractionErrors.push('Product name and description are empty');
      return result;
    }

    // Month name mapping (Spanish to English) - includes common misspellings
    const monthMap: Record<string, string> = {
      // Enero variations
      enero: 'January',
      enro: 'January',
      ennero: 'January',
      
      // Febrero variations
      febrero: 'February',
      feb: 'February',
      febreo: 'February',
      febero: 'February',
      febre: 'February',
      
      // Marzo variations
      marzo: 'March',
      marso: 'March',
      marozo: 'March',
      
      // Abril variations
      abril: 'April',
      abil: 'April',
      abirl: 'April',
      abri: 'April',
      
      // Mayo variations
      mayo: 'May',
      maio: 'May',
      may: 'May',
      
      // Junio variations
      junio: 'June',
      jun: 'June',
      junior: 'June',
      juno: 'June',
      junnio: 'June',
      
      // Julio variations
      julio: 'July',
      jul: 'July',
      julho: 'July',
      jullio: 'July',
      juliyo: 'July',
      
      // Agosto variations
      agosto: 'August',
      ago: 'August',
      agsto: 'August',
      agost: 'August',
      agoto: 'August',
      
      // Septiembre variations
      septiembre: 'September',
      sept: 'September',
      sep: 'September',
      setiembre: 'September',
      septiempre: 'September',
      septimbre: 'September',
      setimbre: 'September',
      setiempre: 'September',
      setimpre: 'September',
      septimpre: 'September',
      
      // Octubre variations
      octubre: 'October',
      oct: 'October',
      otubre: 'October',
      octubr: 'October',
      
      // Noviembre variations
      noviembre: 'November',
      nov: 'November',
      noviempre: 'November',
      novimbre: 'November',
      noviemre: 'November',
      novimpre: 'November',
      novimre: 'November',
      
      // Diciembre variations
      diciembre: 'December',
      dic: 'December',
      dicimbre: 'December',
      dicimpre: 'December',
      dicimre: 'December',
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
    // Pattern 1: Supplier at start, then $ and amount (e.g., "L $ 193 abril")
    // Pattern 2: Supplier with optional spaces before $ (e.g., "L$193", "L $193", "Rx $ 190")
    // Pattern 3: Just amount with $ (e.g., "$193 abril")
    // Note: Supplier pattern doesn't require ^ anchor - can be anywhere in line
    const supplierPattern = /([A-Za-z][A-Za-z0-9\s'.-]{0,19})\s*[\$💲]/;
    const amountPattern = /[\$💲]\s*(\d+[.,]?\d*)/; // Allow comma or dot as decimal separator
    // More flexible month pattern - includes common misspellings
    // Order matters: longer/more specific patterns first to avoid partial matches
    const monthPattern =
      /(enero|enro|ennero|febrero|febreo|febro|febre|feb|marzo|marso|marozo|abril|abil|abirl|abri|mayo|maio|may|junio|juno|junnio|junior|jun|julio|jullio|juliyo|julho|jul|agosto|agsto|agost|agoto|ago|septiembre|setiembre|septiempre|setiempre|septimbre|setimbre|septimpre|setimpre|sept|sep|octubre|otubre|octubr|oct|noviembre|noviempre|novimbre|noviemre|novimpre|novimre|nov|diciembre|dicimbre|dicimpre|dicimre|dic)/i;
    
    // Alternative pattern: Look for $ followed by number anywhere in line
    const simpleAmountPattern = /[\$💲]\s*(\d+[.,]?\d*)/;

    // Step 1: Preprocessing - split by newlines
    const lines = combinedText
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

      // Extract supplier - look for text before the $ symbol
      let supplier = 'General';
      const beforeDollar = line.substring(0, dollarIndex).trim();
      
      // Try strict pattern first (supplier at start)
      const supplierMatch = line.match(supplierPattern);
      if (supplierMatch) {
        supplier = supplierMatch[1].trim();
      } else if (beforeDollar.length > 0) {
        // Extract supplier from text before $
        // Look for common supplier patterns: single letter, short word, etc.
        const words = beforeDollar.split(/\s+/);
        // Common suppliers are usually 1-3 words, often starting with capital letter
        if (words.length > 0) {
          // Take first word if it's short (likely supplier like "L", "Rx", "Center")
          if (words[0].length <= 20 && /^[A-Za-z]/.test(words[0])) {
            supplier = words[0];
          } else if (words.length > 1 && words[0].length + words[1].length <= 20) {
            // Take first two words if combined they're short
            supplier = words.slice(0, 2).join(' ');
          } else {
            // Fallback: take first 20 chars
            supplier = beforeDollar.substring(0, 20).trim();
          }
        }
      }

      // Extract month (optional) - with fuzzy matching for typos
      const monthMatch = line.match(monthPattern);
      let month: string | null = null;
      if (monthMatch) {
        const monthKey = monthMatch[1].toLowerCase().trim();
        
        // First try exact match
        if (monthMap[monthKey]) {
          month = monthMap[monthKey];
        } else {
          // Try fuzzy matching for common typos
          // Normalize common character substitutions and missing letters
          const normalized = monthKey
            .replace(/[í]/g, 'i')  // í -> i
            .replace(/[é]/g, 'e')  // é -> e
            .replace(/[ó]/g, 'o')  // ó -> o
            .replace(/[ú]/g, 'u')  // ú -> u
            .replace(/[bp]/g, 'b') // b/p confusion (normalize to b)
            .replace(/[sz]/g, 's'); // s/z confusion (normalize to s)
          
          if (monthMap[normalized]) {
            month = monthMap[normalized];
          } else {
            // Try matching by first 3-4 characters (common prefix matching)
            const prefix = monthKey.substring(0, Math.min(4, monthKey.length));
            const matchingKey = Object.keys(monthMap).find(key => 
              key.startsWith(prefix) || prefix.startsWith(key.substring(0, Math.min(3, key.length)))
            );
            if (matchingKey) {
              month = monthMap[matchingKey];
            } else {
              // Try Levenshtein-like similarity: find closest match
              // Simple approach: find key with highest character overlap
              let bestMatch: string | null = null;
              let bestScore = 0;
              
              for (const key of Object.keys(monthMap)) {
                // Calculate simple similarity score
                const minLen = Math.min(key.length, monthKey.length);
                let matches = 0;
                for (let i = 0; i < minLen; i++) {
                  if (key[i] === monthKey[i]) matches++;
                }
                const score = matches / Math.max(key.length, monthKey.length);
                
                if (score > bestScore && score > 0.6) { // At least 60% match
                  bestScore = score;
                  bestMatch = key;
                }
              }
              
              if (bestMatch) {
                month = monthMap[bestMatch];
              } else {
                // Last resort: use original if no match found
                month = monthKey;
              }
            }
          }
        }
      }

      // Determine confidence
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
      if (!month) {
        confidence = 'MEDIUM'; // No month, but amount extracted
      }
      if (supplier === 'General' || supplier.length === 0) {
        confidence = 'MEDIUM'; // No supplier identified, but amount is valid
      }

      // Add extracted entry
      result.extractedEntries.push({
        supplier: supplier,
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



