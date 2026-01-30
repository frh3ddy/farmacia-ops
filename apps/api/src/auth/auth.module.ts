import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { EmployeeService } from './employee.service';
import { AuthController } from './auth.controller';
import { EmployeeController } from './employee.controller';
import { PrismaService } from '../prisma/prisma.service';
import {
  DeviceGuard,
  SessionGuard,
  RoleGuard,
  AuthGuard,
  LocationGuard,
} from './guards/auth.guard';

@Module({
  controllers: [AuthController, EmployeeController],
  providers: [
    PrismaService,
    AuthService,
    EmployeeService,
    DeviceGuard,
    SessionGuard,
    RoleGuard,
    AuthGuard,
    LocationGuard,
  ],
  exports: [
    AuthService,
    EmployeeService,
    DeviceGuard,
    SessionGuard,
    RoleGuard,
    AuthGuard,
    LocationGuard,
  ],
})
export class AuthModule {}
