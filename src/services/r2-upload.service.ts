import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PresignedUploadUrlDto } from '../dto/presigned-upload-url.dto';
import { FileType } from '../enums/r2-file.enum';
import {
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
} from '../constants/file-upload.constants';

export interface R2UploadUser {
  id: string;
  email: string;
  tenantId: string;
}

export interface R2UploadResult {
  imageUrl: string;
  filePath: string;
}

export interface R2UploadOptions {
  basePath: string;
  subFolder?: string;
  metadata?: Record<string, string>;
}

@Injectable()
export class R2UploadService {
  private readonly logger = new Logger(R2UploadService.name);
  private s3Client: S3Client;

  constructor(private readonly configService: ConfigService) {
    const accessKeyId = this.configService.get<string>('cloudflareR2AccessKeyId');
    const secretAccessKey = this.configService.get<string>('cloudflareR2SecretAccessKey');
    const endpoint = this.configService.get<string>('cloudflareR2Endpoint');

    if (!accessKeyId || !secretAccessKey || !endpoint) {
      throw new Error('Cloudflare R2 credentials missing');
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    user: R2UploadUser,
    options: R2UploadOptions,
  ): Promise<R2UploadResult> {
    const bucketName = this.configService.get<string>('cloudflareR2BucketName');
    const publicUrl = this.configService.get<string>('cloudflareR2PublicUrl');
    const endpoint = this.configService.get<string>('cloudflareR2Endpoint');
    const accessKeyId = this.configService.get<string>('cloudflareR2AccessKeyId');
    const secretAccessKey = this.configService.get<string>('cloudflareR2SecretAccessKey');

    if (!accessKeyId || !secretAccessKey || !bucketName || !endpoint || !publicUrl) {
      throw new BadRequestException('Cloudflare R2 configuration is missing');
    }

    if (!file) {
      throw new BadRequestException('File is required for upload');
    }

    try {
      const timestamp = Date.now();
      const sanitizedOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const pathParts = [
        options.basePath,
        options.subFolder,
        user.tenantId,
        `${timestamp}-${sanitizedOriginalName}`,
      ].filter(Boolean);
      const fileName = pathParts.join('/');

      const s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      });

      const metadata: Record<string, string> = {
        tenantId: user.tenantId.toString(),
        uploadedBy: user.id.toString(),
        originalFileName: file.originalname,
        ...options.metadata,
      };

      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
        Metadata: metadata,
      });

      await s3Client.send(command);
      const imageUrl = `${publicUrl}/${fileName}`;

      this.logger.log(
        `File uploaded to R2 for tenant ${user.tenantId} by ${user.email}, fileName: ${fileName}`,
      );

      return { imageUrl, filePath: fileName };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error uploading file to R2: ${errorMessage}`);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to upload file to R2');
    }
  }

  async getPresignedUploadUrl(
    user: R2UploadUser,
    dto: PresignedUploadUrlDto,
  ): Promise<{ uploadUrl: string; key: string; expiresAt: Date }> {
    const accessKeyId = this.configService.get<string>('cloudflareR2AccessKeyId');
    const secretAccessKey = this.configService.get<string>('cloudflareR2SecretAccessKey');
    const bucketName = this.configService.get<string>('cloudflareR2BucketName');
    const endpoint = this.configService.get<string>('cloudflareR2Endpoint');

    if (!accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
      throw new BadRequestException('Cloudflare R2 configuration is missing');
    }

    this.validateContentType(dto.fileType, dto.contentType);

    try {
      const timestamp = Date.now();
      const sanitizedFileName = this.sanitizeFileName(dto.fileName);
      const uniqueFileName = `${timestamp}-${sanitizedFileName}`;

      const pathParts = [dto.basePath, dto.subFolder, user.tenantId, uniqueFileName].filter(Boolean);
      const key = pathParts.join('/');

      const s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      });

      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: dto.contentType,
        Metadata: {
          tenantId: user.tenantId.toString(),
          uploadedBy: user.id.toString(),
          fileType: dto.fileType,
          originalFileName: sanitizedFileName,
        },
      });

      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

      return {
        uploadUrl,
        key,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      };
    } catch (error) {
      this.logger.error(
        `Failed to generate presigned URL: ${(error as Error).message}`,
      );
      throw new BadRequestException('Failed to generate upload URL');
    }
  }

  private validateContentType(fileType: FileType, contentType: string): void {
    if (
      fileType === FileType.VIDEO &&
      !ALLOWED_VIDEO_MIMES.includes(contentType as (typeof ALLOWED_VIDEO_MIMES)[number])
    ) {
      throw new BadRequestException(
        `Invalid content type for video. Expected one of: ${ALLOWED_VIDEO_MIMES.join(', ')}`,
      );
    }

    if (
      fileType === FileType.IMAGE &&
      !ALLOWED_IMAGE_MIMES.includes(contentType as (typeof ALLOWED_IMAGE_MIMES)[number])
    ) {
      throw new BadRequestException(
        `Invalid content type for image. Expected one of: ${ALLOWED_IMAGE_MIMES.join(', ')}`,
      );
    }
  }

  private sanitizeFileName(fileName: string): string {
    const baseName = fileName.replace(/^.*[\\/]/, '');
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '-');
    const maxLength = 100;
    return sanitized.slice(0, maxLength);
  }

  getS3Client(): S3Client {
    return this.s3Client;
  }
}
