import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../libs/auth/jwt-auth.guard';
import { CurrentUser } from '../../../libs/auth/guards';
import { AuthUser } from '../../../libs/auth/types';
import { SWAGGER_JWT } from '../../../libs/swagger';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth(SWAGGER_JWT)
@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('fleet-overview')
  @ApiOperation({ summary: "Vehicle list for the caller's tenant" })
  getFleetOverview(@CurrentUser() user: AuthUser) {
    return this.dashboardService.getFleetOverview(user.tenantId);
  }

  @Get('vehicle-statuses')
  @ApiOperation({ summary: "Each vehicle in the caller's tenant with its latest reading (or null)" })
  getVehicleStatuses(@CurrentUser() user: AuthUser) {
    return this.dashboardService.getVehicleStatuses(user.tenantId);
  }
}
