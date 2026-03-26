import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { FileType } from '../enums/r2-file.enum';

export class PresignedUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  basePath: string;

  @IsString()
  @IsOptional()
  subFolder?: string;

  @IsEnum(FileType)
  @IsNotEmpty()
  fileType: FileType;

  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  contentType: string;
}
