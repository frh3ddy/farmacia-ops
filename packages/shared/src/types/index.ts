/**
 * Common job data types
 */
export interface BaseJobData {
  id?: string;
  timestamp?: number;
}

/**
 * Queue job result type
 */
export interface JobResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  duration?: number;
}

/**
 * Connection test result
 */
export interface ConnectionTestResult {
  service: string;
  success: boolean;
  message: string;
  duration?: number;
  error?: string;
}

/**
 * Environment variable validation result
 */
export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
  present: string[];
}

