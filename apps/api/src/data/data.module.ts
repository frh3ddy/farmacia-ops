import { Module } from '@nestjs/common';
import { DataController } from './data.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [DataController],
  providers: [PrismaService],
})
export class DataModule {}

