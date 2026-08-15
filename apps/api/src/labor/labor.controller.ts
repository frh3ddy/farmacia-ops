import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { LaborService } from './labor.service';
import { AuthGuard, RoleGuard, Roles } from '../auth/guards/auth.guard';

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
    const members = await this.laborService.listTeamMembers();
    return { success: true, count: members.length, data: members };
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
    const updated = await this.laborService.updateShiftTimes(id, {
      startAt: body.startAt,
      endAt: body.endAt,
    });

    return {
      success: true,
      message: 'Shift updated',
      data: updated,
    };
  }

  // --------------------------------------------------------------------------
  // Delete a shift (e.g. accidental clock-in) - OWNER, MANAGER
  // --------------------------------------------------------------------------
  @Delete('shifts/:id')
  @Roles('OWNER', 'MANAGER')
  async deleteShift(@Param('id') id: string) {
    await this.laborService.deleteShift(id);
    return { success: true, message: 'Shift deleted' };
  }
}
