import { HttpException, HttpStatus } from '@nestjs/common';

/** Every location runs on Mexico City time; report days and date-only inputs follow it, not the server's clock. */
export const BUSINESS_TIME_ZONE = 'America/Mexico_City';

// ponytail: fixed UTC−6 for parsing — Mexico City has had no DST since Oct 2022.
// Derive the offset per date (Intl/Temporal) if a location opens in another zone.
const BUSINESS_UTC_OFFSET = '-06:00';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY = { start: '00:00:00.000', noon: '12:00:00.000', end: '23:59:59.999' };
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE }); // en-CA formats as YYYY-MM-DD

/**
 * A date-only "2026-02-03" becomes that Mexico City day's start, noon or end;
 * a full ISO timestamp is taken as-is.
 */
export function parseBusinessDate(value: string, at: keyof typeof TIME_OF_DAY = 'noon'): Date {
  return DATE_ONLY.test(value) ? new Date(`${value}T${TIME_OF_DAY[at]}${BUSINESS_UTC_OFFSET}`) : new Date(value);
}

/** An optional date parameter, or a 400 naming it when it isn't a date. */
export function parseDateParam(value: string | undefined, name: string, at: keyof typeof TIME_OF_DAY = 'noon'): Date | undefined {
  if (!value) return undefined;
  const date = parseBusinessDate(value, at);
  if (isNaN(date.getTime())) {
    throw new HttpException({ success: false, message: `Invalid ${name} format` }, HttpStatus.BAD_REQUEST);
  }
  return date;
}

/** The Mexico City calendar day of an instant, as YYYY-MM-DD. */
export function businessDay(date: Date): string {
  return dayFormat.format(date);
}

/** The last millisecond of the Mexico City day that `date` falls on. */
export function endOfBusinessDay(date = new Date()): Date {
  return parseBusinessDate(businessDay(date), 'end');
}
