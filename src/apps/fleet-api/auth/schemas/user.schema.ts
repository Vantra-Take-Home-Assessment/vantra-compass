import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { Role } from '../../../../libs/auth/types';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ default: 'dispatcher' })
  role: Role;

  // Optional until the migration runs; login refuses users without one.
  @Prop({ index: true })
  tenantId?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
