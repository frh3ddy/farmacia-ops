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

/** Midnight on the first of the Mexico City month that `date` falls in. */
export function startOfBusinessMonth(date = new Date()): Date {
  return parseBusinessDate(`${businessDay(date).slice(0, 7)}-01`, 'start');
}

// Expiry dates are calendar days. Date-only input is stored at Mexico City noon
// (parseBusinessDate); older rows at UTC midnight. Both sit on the right day in
// UTC — not in Mexico City — so expiry days are read in UTC, today in Mexico City.
const DAY_MS = 24 * 60 * 60 * 1000;
const utcMidnight = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Calendar days from today (Mexico City) to the expiry day: 0 on the day (expired), negative after. */
export function daysUntilExpiry(expiry: Date, now = new Date()): number {
  return Math.round((utcMidnight(expiry.toISOString().slice(0, 10)) - utcMidnight(businessDay(now))) / DAY_MS);
}

/** UTC midnight of the day `days` after today (Mexico City) — a query bound on expiryDate. */
export function expiryDayStart(days: number, now = new Date()): Date {
  return new Date(utcMidnight(businessDay(now)) + days * DAY_MS);
}
