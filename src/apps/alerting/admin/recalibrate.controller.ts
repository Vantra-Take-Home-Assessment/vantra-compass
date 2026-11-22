import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../libs/auth/jwt-auth.guard';
import { CurrentUser, Roles, RolesGuard } from '../../../libs/auth/guards';
import { AuthUser } from '../../../libs/auth/types';
import { SWAGGER_JWT } from '../../../libs/swagger';
import { AlertStateService } from '../alert-state.service';

// Ops endpoint: admin-only, tenant-scoped, recorded in resolvedBy.
@ApiTags('admin')
@ApiBearerAuth(SWAGGER_JWT)
@Controller('admin/vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class RecalibrateController {
  constructor(private readonly alertState: AlertStateService) {}

  @Post(':vehicleId/force-recalibrate')
  @ApiOperation({ summary: "Acknowledge a vehicle's current offline episode (admin only)" })
  async forceRecalibrate(@CurrentUser() user: AuthUser, @Param('vehicleId') vehicleId: string) {
    const active = await this.alertState.findActiveForVehicle(user.tenantId, vehicleId);
    for (const a of active) {
      await this.alertState.resolveManually(user.tenantId, a._id.toString(), `${user.email} (force-recalibrate)`);
    }
    return { vehicleId, recalibrated: true, clearedAlerts: active.length };
  }
}
