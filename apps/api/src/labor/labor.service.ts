import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClient, SquareEnvironment } from 'square';
import type { Shift } from 'square/api';

// ============================================================================
// Types
// ============================================================================

export interface PayrollPeriod {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

export interface ShiftSummary {
  shiftId: string;
  date: string;            // Local date of the shift (YYYY-MM-DD)
  startAt: string;         // RFC3339 as returned by Square (location tz offset)
  endAt: string | null;    // null when the shift is still OPEN
  status: string | null;
  workedMinutes: number;
  hours: number;           // whole hours
  minutes: number;         // remainder minutes
  hourlyRate: number;      // dollars (major currency unit)
  currency: string;
  cost: number;            // pay for this shift
  jobTitle: string | null;
}

export interface PayrollSummary {
  teamMemberId: string;
  period: PayrollPeriod;
  hourlyRate: number;      // most recent rate found in the period
  currency: string;
  totalWorkedMinutes: number;
  totalHours: number;
  totalMinutes: number;    // remainder minutes
  workedDays: number;      // distinct dates with at least one shift
  totalCost: number;
  shifts: ShiftSummary[];
}

interface TeamMemberSummary {
  id: string;
  givenName: string;
  familyName: string;
  fullName: string;
  status: string | null;
}

// ============================================================================
// Constants
// ============================================================================

// Default timezone used for Square workday queries. Square's own
// defaultTimezone in the workday filter is the location timezone, so we pass
// the business timezone explicitly to keep day boundaries deterministic and
// independent from the server timezone.
const DEFAULT_TIMEZONE = 'America/Mexico_City';
const DEFAULT_HOURLY_RATE_CENTS = 0;

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class LaborService {
  private readonly logger = new Logger(LaborService.name);
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  // Square client (same pattern as CatalogService)
  // --------------------------------------------------------------------------

  private getSquareClient(): SquareClient {
    if (!this.squareClient) {
      const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();

      if (!squareAccessToken) {
        throw new HttpException(
          {
            success: false,
            message: 'SQUARE_ACCESS_TOKEN environment variable is not set',
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      let squareEnvironment: SquareEnvironment;
      const nodeEnv = process.env.NODE_ENV?.toLowerCase();
      const railwayEnv = process.env.RAILWAY_ENVIRONMENT?.toLowerCase();
      const squareEnv = process.env.SQUARE_ENVIRONMENT?.toLowerCase();

      if (
        squareEnv === 'sandbox' ||
        nodeEnv === 'development' ||
        nodeEnv === 'dev' ||
        railwayEnv === 'staging' ||
        railwayEnv === 'development'
      ) {
        squareEnvironment = SquareEnvironment.Sandbox;
      } else {
        squareEnvironment = SquareEnvironment.Production;
      }

      this.squareClient = new SquareClient({
        token: squareAccessToken,
        environment: squareEnvironment,
      });
    }
    return this.squareClient;
  }

  // --------------------------------------------------------------------------
  // Date helpers (timezone-safe)
  // --------------------------------------------------------------------------

  /**
   * Get the current local date (YYYY-MM-DD) in the business timezone.
   * Uses the Intl API so the result does not depend on the server timezone.
   */
  private nowInTimezone(timeZone: string = DEFAULT_TIMEZONE): {
    year: number;
    month: number;
    day: number;
  } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());

    const get = (type: string) =>
      parseInt(parts.find(p => p.type === type)?.value || '0', 10);

    return { year: get('year'), month: get('month'), day: get('day') };
  }

  /**
   * Build a YYYY-MM-DD date string from y/m/d parts (no Date object, so no
   * timezone conversion can shift the day).
   */
  private toDateString(year: number, month: number, day: number): string {
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  /**
   * Day-of-week of a local date without timezone interference.
   * Noon UTC is used so the weekday is the same regardless of the server tz.
   * Returns 0 = Monday ... 6 = Sunday (ISO week).
   */
  private weekdayOf(dateStr: string): number {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return (d.getUTCDay() + 6) % 7; // ISO: Monday = 0
  }

  /** Add (or subtract) days to a YYYY-MM-DD string. Noon UTC is safe. */
  private addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Resolve the requested pay period:
   * - explicit startDate/endDate win
   * - weekOffset N means "N weeks ago" (0 = current week, Monday-Sunday)
   * - default: current week (Monday-Sunday)
   */
  private resolvePeriod(options: {
    startDate?: string;
    endDate?: string;
    weekOffset?: number;
  }): PayrollPeriod {
    if (options.startDate && options.endDate) {
      return { startDate: options.startDate, endDate: options.endDate };
    }

    const now = this.nowInTimezone();
    const today = this.toDateString(now.year, now.month, now.day);
    const offset = options.weekOffset ?? 0;

    // Monday of the requested week
    const monday = this.addDays(today, -this.weekdayOf(today) - offset * 7);
    const sunday = this.addDays(monday, 6);

    return { startDate: monday, endDate: sunday };
  }

  /**
   * Extract the local date (YYYY-MM-DD) from an RFC3339 timestamp. Square
   * returns shift times already offset to the location timezone, so the date
   * portion of the string is the local business date. If the string carries a
   * different offset (e.g. UTC), convert it into the business timezone.
   */
  private localDateOf(rfc3339: string, timeZone: string): string {
    // Square location-tz timestamps look like "2019-01-25T03:11:00-05:00"
    // and endAt/createdAt in UTC look like "2020-02-07T23:11:00Z".
    const match = rfc3339.match(
      /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:\d{2})?$/,
    );

    if (match && match[2] && match[2] !== 'Z') {
      // The timestamp already carries a location offset. Take the date part
      // as-is — Square guarantees it is shifted to the location timezone.
      return match[1];
    }

    // Fallback: convert to the business timezone using the Intl API.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(rfc3339));
    const get = (type: string) =>
      parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  // --------------------------------------------------------------------------
  // Labor math
  // --------------------------------------------------------------------------

  private minutesBetween(startAt: string, endAt?: string | null): number {
    const start = new Date(startAt).getTime();
    const end = endAt ? new Date(endAt).getTime() : Date.now();
    return Math.max(0, Math.round((end - start) / 60000));
  }

  private toShiftSummary(
    shift: Shift,
    timeZone: string,
    fallbackRateCents: number,
    currency: string,
  ): ShiftSummary {
    const rateCents =
      shift.wage?.hourlyRate?.amount != null
        ? Number(shift.wage.hourlyRate.amount)
        : fallbackRateCents;

    const workedMinutes = this.minutesBetween(shift.startAt, shift.endAt);
    const hourlyRate = rateCents / 100;
    const cost = Math.round(((workedMinutes / 60) * hourlyRate) * 100) / 100;

    return {
      shiftId: shift.id || '',
      date: this.localDateOf(shift.startAt, timeZone),
      startAt: shift.startAt,
      endAt: shift.endAt ?? null,
      status: shift.status ?? null,
      workedMinutes,
      hours: Math.floor(workedMinutes / 60),
      minutes: workedMinutes % 60,
      hourlyRate,
      currency,
      cost,
      jobTitle: shift.wage?.title ?? null,
    };
  }

  // --------------------------------------------------------------------------
  // Team members
  // --------------------------------------------------------------------------

  async listTeamMembers(): Promise<TeamMemberSummary[]> {
    const client = this.getSquareClient();

    try {
      const response = await client.teamMembers.search({
        query: {
          filter: {
            status: 'ACTIVE',
            isOwner: false,
          },
        },
      });

      const members = response.teamMembers || [];

      return members.map(m => ({
        id: m.id || '',
        givenName: m.givenName || '',
        familyName: m.familyName || '',
        fullName: [m.givenName, m.familyName].filter(Boolean).join(' ').trim(),
        status: m.status ?? null,
      }));
    } catch (error) {
      this.logger.error('[LABOR] Failed to list team members', error);
      throw new HttpException(
        { success: false, message: 'Failed to fetch team members from Square' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Shifts + payroll summary
  // --------------------------------------------------------------------------

  async getPayrollSummary(
    teamMemberId: string,
    options: { startDate?: string; endDate?: string; weekOffset?: number },
  ): Promise<PayrollSummary> {
    if (!teamMemberId) {
      throw new HttpException(
        { success: false, message: 'teamMemberId is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const period = this.resolvePeriod(options);

    if (period.startDate > period.endDate) {
      throw new HttpException(
        { success: false, message: 'startDate must be before or equal to endDate' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const client = this.getSquareClient();
    const timeZone = DEFAULT_TIMEZONE;

    this.logger.log(
      `[LABOR] Searching shifts: teamMemberId=${teamMemberId} period=${period.startDate}..${period.endDate}`,
    );

    try {
      const shifts: Shift[] = [];
      let cursor: string | undefined = undefined;

      do {
        const response = await client.labor.shifts.search({
          query: {
            filter: {
              teamMemberIds: [teamMemberId],
              workday: {
                dateRange: {
                  startDate: period.startDate,
                  endDate: period.endDate,
                },
                matchShiftsBy: 'START_AT',
                defaultTimezone: timeZone,
              },
            },
            sort: { field: 'START_AT', order: 'ASC' },
          },
          limit: 200,
          ...(cursor && { cursor }),
        });

        shifts.push(...(response.shifts || []));
        cursor = response.cursor || undefined;
      } while (cursor);

      this.logger.log(
        `[LABOR] Found ${shifts.length} shift(s) for ${teamMemberId} in ${period.startDate}..${period.endDate}`,
      );

      if (shifts.length === 0) {
        // Diagnostic: fetch without workday filter to see if the team member
        // has ANY shifts at all (helps distinguish "no shifts ever" from
        // "workday filter excluded them").
        const probe = await client.labor.shifts.search({
          query: {
            filter: { teamMemberIds: [teamMemberId] },
            sort: { field: 'START_AT', order: 'DESC' },
          },
          limit: 10,
        });
        const probeShifts = probe.shifts || [];
        this.logger.warn(
          `[LABOR] No shifts in period ${period.startDate}..${period.endDate}. ` +
            `Team member has ${probeShifts.length} total shift(s) (latest 10). ` +
            `Dates: ${probeShifts.map(s => (s.startAt || '').slice(0, 10)).join(', ') || 'none'}; ` +
            `Locations: ${[...new Set(probeShifts.map(s => s.locationId))].join(', ') || 'none'}; ` +
            `Statuses: ${[...new Set(probeShifts.map(s => s.status))].join(', ') || 'none'}`,
        );
      }

      // Most recent hourly rate found in the period (used as the payroll rate
      // and as fallback for shifts without wage info).
      let rateCents = DEFAULT_HOURLY_RATE_CENTS;
      let currency = 'USD';
      for (const shift of shifts) {
        if (shift.wage?.hourlyRate?.amount != null) {
          rateCents = Number(shift.wage.hourlyRate.amount);
          currency = shift.wage.hourlyRate.currency || currency;
        }
      }

      const summaries = shifts.map(s =>
        this.toShiftSummary(s, timeZone, rateCents, currency),
      );

      const totalWorkedMinutes = summaries.reduce(
        (acc, s) => acc + s.workedMinutes,
        0,
      );
      const workedDays = new Set(summaries.map(s => s.date)).size;
      const hourlyRate = rateCents / 100;
      const totalCost =
        Math.round(((totalWorkedMinutes / 60) * hourlyRate) * 100) / 100;

      return {
        teamMemberId,
        period,
        hourlyRate,
        currency,
        totalWorkedMinutes,
        totalHours: Math.floor(totalWorkedMinutes / 60),
        totalMinutes: totalWorkedMinutes % 60,
        workedDays,
        totalCost,
        shifts: summaries,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('[LABOR] Failed to search shifts', error);
      throw new HttpException(
        { success: false, message: 'Failed to fetch shifts from Square' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Shift time adjustment
  // --------------------------------------------------------------------------

  async updateShiftTimes(
    shiftId: string,
    updates: { startAt?: string; endAt?: string | null },
  ) {
    if (!shiftId) {
      throw new HttpException(
        { success: false, message: 'shiftId is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (updates.startAt === undefined && updates.endAt === undefined) {
      throw new HttpException(
        { success: false, message: 'Provide startAt and/or endAt' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const client = this.getSquareClient();

    try {
      // 1. Fetch current shift
      const current = await client.labor.shifts.get({ id: shiftId });
      const shift = current.shift;

      if (!shift) {
        throw new HttpException(
          { success: false, message: `Shift ${shiftId} not found` },
          HttpStatus.NOT_FOUND,
        );
      }

      // 2. Apply the new times. Square requires full precision RFC3339 with
      // offset; seconds are truncated by Square.
      const updatedShift: Shift = {
        ...shift,
        startAt: updates.startAt ?? shift.startAt,
        endAt:
          updates.endAt !== undefined ? (updates.endAt ?? null) : shift.endAt,
        version: shift.version,
      };

      // 3. Persist
      const result = await client.labor.shifts.update({
        id: shiftId,
        shift: updatedShift,
      });

      const saved = result.shift;
      if (!saved) {
        throw new Error('Square did not return the updated shift');
      }

      const timeZone = saved.timezone || DEFAULT_TIMEZONE;
      const rateCents =
        saved.wage?.hourlyRate?.amount != null
          ? Number(saved.wage.hourlyRate.amount)
          : DEFAULT_HOURLY_RATE_CENTS;

      return this.toShiftSummary(
        saved,
        timeZone,
        rateCents,
        saved.wage?.hourlyRate?.currency || 'USD',
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`[LABOR] Failed to update shift ${shiftId}`, error);
      throw new HttpException(
        { success: false, message: 'Failed to update shift in Square' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Shift deletion (e.g. accidental clock-in)
  // --------------------------------------------------------------------------

  async deleteShift(shiftId: string): Promise<void> {
    if (!shiftId) {
      throw new HttpException(
        { success: false, message: 'shiftId is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const client = this.getSquareClient();

    try {
      await client.labor.shifts.delete({ id: shiftId });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`[LABOR] Failed to delete shift ${shiftId}`, error);
      throw new HttpException(
        { success: false, message: 'Failed to delete shift in Square' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
