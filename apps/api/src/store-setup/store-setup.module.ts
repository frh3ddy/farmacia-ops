import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { StoreSetupController } from './store-setup.controller';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [StoreSetupController],
  providers: [PrismaService],
})
export class StoreSetupModule {}
