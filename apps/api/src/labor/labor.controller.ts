import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { LaborService } from './labor.service';
import { AuthGuard, RoleGuard, Roles } from '../auth/guards/auth.guard';

// Helper functions (same pattern as expense.controller.ts)
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

interface UpdateShiftTimesDto {
  startAt?: string;
  endAt?: string | null;
}

/**
 * Labor / payroll endpoints backed by the Square Team + Labor APIs.
 *
 * Timezone note: all period boundaries are computed in the business timezone
 * (America/Mexico_City by default) and Square shift timestamps already carry
 * the location offset, so hour math never depends on the server timezone.
 */
@Controller('labor')
@UseGuards(AuthGuard, RoleGuard)
export class LaborController {
  constructor(private readonly laborService: LaborService) {}

  // --------------------------------------------------------------------------
  // List Square team members - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('team-members')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async listTeamMembers() {
    try {
      const members = await this.laborService.listTeamMembers();
      return { success: true, count: members.length, data: members };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error),
      );
    }
  }

  // --------------------------------------------------------------------------
  // Payroll summary for a team member over a period
  // - ?teamMemberId=xxx (required)
  // - ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (custom range) OR
  // - ?weekOffset=0 (0 = current week, 1 = last week, ...) — default 0
  // --------------------------------------------------------------------------
  @Get('payroll-summary')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getPayrollSummary(
    @Query('teamMemberId') teamMemberId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('weekOffset') weekOffset?: string,
  ) {
    try {
      if (!teamMemberId) {
        throw new HttpException(
          { success: false, message: 'teamMemberId is required' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (
        (startDate && !dateRegex.test(startDate)) ||
        (endDate && !dateRegex.test(endDate))
      ) {
        throw new HttpException(
          { success: false, message: 'startDate/endDate must be YYYY-MM-DD' },
          HttpStatus.BAD_REQUEST,
        );
      }

      if ((startDate && !endDate) || (!startDate && endDate)) {
        throw new HttpException(
          {
            success: false,
            message: 'Provide both startDate and endDate for a custom range',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const summary = await this.laborService.getPayrollSummary(teamMemberId, {
        startDate,
        endDate,
        weekOffset:
          weekOffset !== undefined ? parseInt(weekOffset, 10) : undefined,
      });

      return { success: true, data: summary };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error),
      );
    }
  }

  // --------------------------------------------------------------------------
  // Adjust shift start/end times - OWNER, MANAGER
  // Times must be full RFC3339 with offset (e.g. 2026-08-10T09:00:00-06:00)
  // --------------------------------------------------------------------------
  @Put('shifts/:id')
  @Roles('OWNER', 'MANAGER')
  async updateShiftTimes(
    @Param('id') id: string,
    @Body() body: UpdateShiftTimesDto,
  ) {
    try {
      const updated = await this.laborService.updateShiftTimes(id, {
        startAt: body.startAt,
        endAt: body.endAt,
      });

      return {
        success: true,
        message: 'Shift updated',
        data: updated,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error),
      );
    }
  }
}
