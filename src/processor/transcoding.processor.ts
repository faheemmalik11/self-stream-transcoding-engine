import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Upload } from '@aws-sdk/lib-storage';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { R2UploadService } from '../services/r2-upload.service';
import { Video } from '../entities/video.entity';
import { VideoHlsStatus } from '../enums/video-hls-status.enum';

interface TranscodingJobData {
  videoId: string;
  key: string;
  tenantId: string;
}

@Processor('video-transcoding')
export class TranscodingProcessor extends WorkerHost {
  private readonly logger = new Logger(TranscodingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly configService: ConfigService,
    private readonly r2UploadService: R2UploadService,
  ) {
    super();
  }

  async process(job: Job<TranscodingJobData>): Promise<void> {
    const { videoId, key, tenantId } = job.data;
    this.logger.log(
      `Starting transcoding job for video ${videoId}, key: ${key}`,
    );

    const workDir = path.join('/tmp', 'hls', tenantId, videoId);
    const outputDir = path.join(workDir, 'output');

    try {
      await fs.ensureDir(outputDir);

      const tempVideoPath = await this.downloadVideo(key, workDir);

      this.configureFfmpeg();

      const durationSeconds = await this.getVideoDuration(tempVideoPath);

      await this.transcodeToHls(tempVideoPath, outputDir);

      const hlsMasterUrl = await this.uploadHlsFiles(key, videoId, outputDir);

      await this.updateVideoStatus(videoId, {
        hlsUrl: hlsMasterUrl,
        hlsStatus: VideoHlsStatus.READY,
        durationSeconds: durationSeconds,
      });

      this.logger.log(
        `Transcoding completed successfully for video ${videoId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Transcoding failed for video ${videoId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.updateVideoStatus(videoId, {
        hlsStatus: VideoHlsStatus.FAILED,
      });

      throw error;
    } finally {
      await this.cleanup(workDir);
    }
  }

  private async downloadVideo(key: string, workDir: string): Promise<string> {
    const publicBase =
      this.configService.get<string>('cloudflareR2PublicUrl') ||
      'https://pub-xxxx.r2.dev';
    const inputUrl = `${publicBase}/${key}`;

    this.logger.log(`Downloading video from ${inputUrl}`);

    const response = await fetch(inputUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download video: ${response.status} ${response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error('Failed to download video: empty response body');
    }

    const tempVideoPath = path.join(workDir, `input${path.extname(key)}`);
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      createWriteStream(tempVideoPath),
    );

    const contentLength = response.headers.get('content-length');
    this.logger.log(
      `Downloaded video to ${tempVideoPath}${contentLength ? ` (${contentLength} bytes)` : ''}`,
    );
    return tempVideoPath;
  }

  private configureFfmpeg(): void {
    const possiblePaths = ['/usr/bin/ffmpeg'];

    let foundPath: string | null = null;

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }

    if (foundPath) {
      ffmpeg.setFfmpegPath(foundPath);
      const ffprobePath = foundPath.replace('ffmpeg', 'ffprobe');
      if (fs.existsSync(ffprobePath)) {
        ffmpeg.setFfprobePath(ffprobePath);
        this.logger.log(
          `Using system FFmpeg at: ${foundPath}, FFprobe at: ${ffprobePath}`,
        );
      } else {
        this.logger.log(`Using system FFmpeg at: ${foundPath}`);
      }
    } else {
      this.logger.warn('System FFmpeg not found in common locations.');
    }
  }

  private async getVideoDuration(videoPath: string): Promise<number | null> {
    return new Promise<number | null>((resolve, _reject) => {
      this.logger.log(`Extracting video duration from: ${videoPath}`);

      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          this.logger.warn(
            `Failed to extract video duration: ${(err as Error).message}`,
          );
          resolve(null);
          return;
        }

        const duration = metadata?.format?.duration;
        if (duration !== undefined && duration !== null && !isNaN(duration)) {
          const durationSeconds = Math.round(duration);
          this.logger.log(
            `Video duration extracted: ${durationSeconds} seconds (${duration.toFixed(2)}s raw)`,
          );
          resolve(durationSeconds);
        } else {
          this.logger.warn(`Video duration not found in metadata`);
          resolve(null);
        }
      });
    });
  }

  /**
   * Transcode video to multi-variant HLS format.
   * Creates two variants: 480p and 720p.
   * Encodes variants sequentially to reduce peak memory usage on small instances.
   */
  private async transcodeToHls(
    inputPath: string,
    outputDir: string,
  ): Promise<void> {
    this.logger.log(
      `Starting multi-variant HLS transcoding: ${inputPath} -> ${outputDir}`,
    );

    const v0Dir = path.join(outputDir, 'v0');
    const v1Dir = path.join(outputDir, 'v1');
    await fs.ensureDir(v0Dir);
    await fs.ensureDir(v1Dir);

    await this.encodeVariant(inputPath, v0Dir, {
      resolution: '854x480',
      bitrate: '1250k',
      maxrate: '1500k',
      bufsize: '3000k',
      name: 'v480',
    });

    await this.encodeVariant(inputPath, v1Dir, {
      resolution: '1280x720',
      bitrate: '3000k',
      maxrate: '3500k',
      bufsize: '7000k',
      name: 'v720',
    });

    await this.createMasterPlaylist(outputDir, [
      {
        name: 'v480',
        path: 'v0/playlist.m3u8',
        resolution: '854x480',
        bandwidth: 1500000,
      },
      {
        name: 'v720',
        path: 'v1/playlist.m3u8',
        resolution: '1280x720',
        bandwidth: 3500000,
      },
    ]);

    this.logger.log('Multi-variant HLS transcoding completed');
  }

  private async encodeVariant(
    inputPath: string,
    outputDir: string,
    config: {
      resolution: string;
      bitrate: string;
      maxrate: string;
      bufsize: string;
      name: string;
    },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.logger.log(
        `Encoding variant ${config.name} (${config.resolution})...`,
      );

      ffmpeg(inputPath)
        .outputOptions([
          '-preset veryfast',
          '-threads 2',
          '-g 48',
          '-sc_threshold 0',
          '-c:v libx264',
          `-s ${config.resolution}`,
          `-b:v ${config.bitrate}`,
          `-maxrate ${config.maxrate}`,
          `-bufsize ${config.bufsize}`,
          '-profile:v high',
          '-level 4.0',
          '-c:a aac',
          '-b:a 128k',
          '-ar 44100',
          '-f hls',
          '-hls_time 6',
          '-hls_list_size 0',
          '-hls_segment_filename',
          path.join(outputDir, 'segment_%03d.ts'),
          '-hls_flags delete_segments',
        ])
        .output(path.join(outputDir, 'playlist.m3u8'))
        .on('start', (cmd) => {
          this.logger.debug(`FFmpeg command for ${config.name}: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            this.logger.debug(
              `${config.name} transcoding progress: ${progress.percent.toFixed(1)}%`,
            );
          }
        })
        .on('end', () => {
          this.logger.log(`Variant ${config.name} encoding completed`);
          resolve();
        })
        .on('error', (err, _stdout, stderr) => {
          this.logger.error(`FFmpeg error for ${config.name}: ${err.message}`);
          if (stderr) {
            this.logger.error(`FFmpeg stderr: ${stderr}`);
          }
          reject(err);
        })
        .run();
    });
  }

  private async createMasterPlaylist(
    outputDir: string,
    variants: Array<{
      name: string;
      path: string;
      resolution: string;
      bandwidth: number;
    }>,
  ): Promise<void> {
    const masterPlaylistPath = path.join(outputDir, 'playlist.m3u8');

    let playlistContent = '#EXTM3U\n';
    playlistContent += '#EXT-X-VERSION:3\n\n';

    for (const variant of variants) {
      const [width, height] = variant.resolution.split('x');
      playlistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${width}x${height},NAME="${variant.name}"\n`;
      playlistContent += `${variant.path}\n\n`;
    }

    await fs.writeFile(masterPlaylistPath, playlistContent);
    this.logger.log(`Master playlist created: ${masterPlaylistPath}`);
  }

  private async uploadHlsFiles(
    originalKey: string,
    videoId: string,
    outputDir: string,
  ): Promise<string> {
    this.logger.log('Uploading HLS files to R2...');

    const s3Client = this.r2UploadService.getS3Client();
    const bucketName = this.configService.get<string>('cloudflareR2BucketName');
    const publicBase =
      this.configService.get<string>('cloudflareR2PublicUrl') ||
      'https://pub-xxxx.r2.dev';

    if (!bucketName) {
      throw new Error('R2 bucket name not configured');
    }

    const uploadFile = async (
      localPath: string,
      relativePath: string,
    ): Promise<void> => {
      const fileName = path.basename(localPath);
      const r2Key = `${path.dirname(originalKey)}/hls/${videoId}/${relativePath}`;

      const contentType = fileName.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t';

      try {
        const upload = new Upload({
          client: s3Client,
          params: {
            Bucket: bucketName,
            Key: r2Key,
            Body: fs.createReadStream(localPath),
            ContentType: contentType,
          },
          partSize: 5 * 1024 * 1024,
          queueSize: 4,
        });

        await upload.done();
        this.logger.debug(`Uploaded ${relativePath} -> ${r2Key} (multipart)`);
      } catch (err) {
        this.logger.error(
          `Upload failed for ${r2Key}: ${(err as Error).message}`,
        );
        throw err;
      }
    };

    const processDirectory = async (
      dir: string,
      relativeDir = '',
    ): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name;

        if (entry.isDirectory()) {
          await processDirectory(fullPath, relativePath);
        } else if (entry.isFile()) {
          await uploadFile(fullPath, relativePath);
        }
      }
    };

    await processDirectory(outputDir);

    const hlsMasterUrl = `${publicBase}/${path.dirname(originalKey)}/hls/${videoId}/playlist.m3u8`;
    this.logger.log(`HLS files uploaded. Master playlist: ${hlsMasterUrl}`);

    return hlsMasterUrl;
  }

  private async updateVideoStatus(
    videoId: string,
    updates: {
      hlsUrl?: string;
      hlsStatus?: VideoHlsStatus;
      durationSeconds?: number | null;
    },
  ): Promise<void> {
    const result = await this.videoRepository.update({ id: videoId }, updates);

    if (result.affected === 0) {
      this.logger.warn(`Video ${videoId} not found when updating status`);
    } else {
      this.logger.log(
        `Updated video ${videoId} status: ${JSON.stringify(updates)}`,
      );
    }
  }

  private async cleanup(workDir: string): Promise<void> {
    try {
      if (await fs.pathExists(workDir)) {
        await fs.remove(workDir);
        this.logger.debug(`Cleaned up work directory: ${workDir}`);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to cleanup work directory ${workDir}: ${errorMessage}`,
      );
    }
  }
}
