import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VideoHlsStatus } from '../enums/video-hls-status.enum';

/**
 * Minimal Video entity required by the transcoding engine.
 *
 * In your own project you will likely extend this with additional columns
 * (thumbnailUrl, format, orientation, relations, etc.).
 * The transcoding processor only reads/writes: id, hlsUrl, hlsStatus, durationSeconds.
 */
@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 500, name: 'original_key', nullable: true })
  originalKey: string | null;

  @Column({ type: 'varchar', length: 500, name: 'hls_url', nullable: true })
  hlsUrl: string | null;

  @Column({
    type: 'enum',
    enum: VideoHlsStatus,
    name: 'hls_status',
    default: VideoHlsStatus.PENDING,
    nullable: true,
  })
  hlsStatus: VideoHlsStatus | null;

  @Column({ type: 'integer', name: 'duration_seconds', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'varchar', length: 500, name: 'video_file_url', nullable: true })
  videoFileUrl: string | null;

  @Column({ type: 'varchar', length: 500, name: 'download_url', nullable: true })
  downloadUrl: string | null;

  @Column({ type: 'text', name: 'title' })
  title: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
