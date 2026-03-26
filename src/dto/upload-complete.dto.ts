import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class UploadCompleteDto {
  @IsUUID('4')
  @IsNotEmpty()
  videoId: string;

  @IsString()
  @IsNotEmpty()
  key: string;
}
