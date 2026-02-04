import { Module, forwardRef } from '@nestjs/common';
import { DataController } from './data.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [DataController],
  providers: [PrismaService],
})
export class DataModule {}

