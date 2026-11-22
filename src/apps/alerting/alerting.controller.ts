import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../libs/auth/jwt-auth.guard';
import { CurrentUser, RolesGuard } from '../../libs/auth/guards';
import { AuthUser } from '../../libs/auth/types';
import { SWAGGER_JWT } from '../../libs/swagger';
import { AlertStateService } from './alert-state.service';

@ApiTags('alerts')
@ApiBearerAuth(SWAGGER_JWT)
@Controller('alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AlertingController {
  constructor(private readonly alertState: AlertStateService) {}

  /** Active alerts for a vehicle, within the caller's tenant only. */
  @Get(':vehicleId')
  @ApiOperation({ summary: "Active alerts for a vehicle in the caller's tenant" })
  findActive(@CurrentUser() user: AuthUser, @Param('vehicleId') vehicleId: string) {
    return this.alertState.findActiveForVehicle(user.tenantId, vehicleId);
  }

  @Post(':alertId/resolve')
  @ApiOperation({ summary: 'Manually resolve an alert' })
  resolve(@CurrentUser() user: AuthUser, @Param('alertId') alertId: string) {
    return this.alertState.resolveManually(user.tenantId, alertId, user.email);
  }
}
