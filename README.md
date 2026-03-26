# Self-Stream Transcoding Engine

> **Stop paying per minute. Own your video pipeline.**

A production-ready, self-hosted video transcoding engine built on NestJS. Upload videos directly to Cloudflare R2, transcode to adaptive bitrate HLS with FFmpeg, and stream to any device — all for the flat cost of a single server.

---

## The Cost Problem With Managed Video Platforms

Platforms like Cloudflare Stream and Mux charge **per minute of video stored** and **per minute of video delivered**. That sounds cheap until your library grows.

| Scenario | Cloudflare Stream | This Engine |
|---|---|---|
| 100 videos × 10 min avg, 50 views/video/mo | ~$55/mo | ~$21/mo |
| 500 videos × 10 min avg, 50 views/video/mo | ~$275/mo | ~$21/mo |
| 1,000 videos × 10 min avg, 50 views/video/mo | ~$550/mo | ~$23/mo |
| 5,000 videos × 10 min avg, 50 views/video/mo | ~$2,750/mo | ~$28/mo |

**Managed platforms scale linearly with your library. This engine doesn't.**

Your costs with this engine:
- **Server**: ~$10–40/mo (EC2 t3.small or equivalent VPS) — flat, regardless of video count
- **Storage**: ~$0.015/GB/mo on Cloudflare R2 — 1,000 videos ≈ $3/mo
- **Bandwidth**: **$0** — Cloudflare R2 has zero egress fees

Beyond ~50 videos, self-hosting wins. At 1,000+ videos, you're saving hundreds of dollars every month.

---

## What it Does

- **Direct browser upload** to Cloudflare R2 via presigned URLs — no proxying through your backend
- **Background transcoding** via BullMQ so uploads never block the user
- **Multi-variant HLS** (480p + 720p) for adaptive bitrate streaming on any device
- **Real-time status tracking**: `PENDING → PROCESSING → READY | FAILED`
- **Auto-retry** on failure with exponential backoff via BullMQ
- **Multi-tenant** — video paths are scoped by `tenantId`

---

## Tech Stack

Every component was chosen to keep costs low and reliability high:

| Layer | Technology | Why |
|---|---|---|
| **Queue** | BullMQ + Redis | Reliable job processing with retries & backoff — no dropped jobs |
| **Transcoding** | FFmpeg (libx264 + AAC) | Industry-standard, free, runs on any Linux server |
| **Storage** | Cloudflare R2 (S3-compatible) | $0.015/GB/mo storage, **zero egress fees** — no bandwidth bill |
| **Upload** | AWS SDK v3 (S3Client) | Presigned URLs let the browser upload directly — no backend bandwidth cost |
| **Database** | PostgreSQL + TypeORM | Video metadata and status tracking |
| **Framework** | NestJS | Backend API + BullMQ worker host |

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Browser)                            │
└──────────┬──────────────────────────────────────────────────┬───────────┘
           │                                                  │
           ▼                                                  ▼
   ┌──────────────────┐                             ┌──────────────────┐
   │ 1. Get Presigned │                             │ 6. Play Video    │
   │    Upload URL    │                             │    (hls.js)      │
   └───────┬──────────┘                             └─────────┬────────┘
           │                                                  │
           ▼                                                  ▼
   ┌────────────────┐                               ┌─────────────────┐
   │ 2. Upload MP4  │                               │ Load master     │
   │    directly    │                               │ playlist.m3u8   │
   │    to R2       │                               │ from R2         │
   │    (progress %)│                               └─────────────────┘
   └───────┬────────┘
           │ Upload complete
           ▼
   ┌────────────────────┐
   │ 3. POST /queue-    │
   │    transcoding     │
   │    { videoId, key }│
   └───────┬────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            BACKEND (NestJS)                              │
│                                                                          │
│   ┌───────────────────┐        ┌───────────────────┐                     │
│   │ Videos Service    │        │ R2 Upload Service │                     │
│   │                   │        │                   │                     │
│   │ • Create video    │        │ • Presigned URLs  │                     │
│   │   record (DB)     │        │ • S3 client       │                     │
│   │ • Set status =    │        │ • File upload     │                     │
│   │   PROCESSING      │        │                   │                     │
│   │ • Enqueue job ──────────┐  └───────────────────┘                     │
│   └──────────────────┘      │                                            │
│                             ▼                                            │
│                     ┌───────────────┐                                    │
│                     │   BullMQ      │                                    │
│                     │   Redis Queue │                                    │
│                     │  "video-      │                                    │
│                     │   transcoding"│                                    │
│                     └──────┬────────┘                                    │
│                            │                                             │
│                            ▼                                             │
│            ┌───────────────────────────────┐                             │
│            │  4. TRANSCODING PROCESSOR     │ ◄── THIS REPO               │
│            │     (BullMQ Worker)           │                             │
│            │                               │                             │
│            │  a) Download MP4 from R2      │                             │
│            │  b) FFprobe: extract duration │                             │
│            │  c) FFmpeg: encode 480p HLS   │                             │
│            │  d) FFmpeg: encode 720p HLS   │                             │
│            │  e) Generate master playlist  │                             │
│            │  f) Upload HLS files to R2    │                             │
│            │  g) Update DB: hlsUrl, status │                             │
│            │  h) Cleanup temp files        │                             │
│            └───────────────┬───────────────┘                             │
│                            │                                             │
│                            ▼                                             │
│                   ┌──────────────────┐                                   │
│                   │ 5. DB Updated    │                                   │
│                   │ hlsStatus=READY  │                                   │
│                   │ hlsUrl=https://  │                                   │
│                   │  .../playlist    │                                   │
│                   │  .m3u8           │                                   │
│                   └──────────────────┘                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Transcoding Pipeline — Step by Step

```
   Upload MP4 to R2
         │
         ▼
  ┌──────────────┐     ┌─────────┐
  │ Videos       │────►│ BullMQ  │
  │ Service      │     │ Redis   │
  │ status=      │     │ Queue   │
  │ PROCESSING   │     └────┬────┘
  └──────────────┘          │
                            │ Worker picks up job
                            ▼
                 ┌──────────────────────┐
                 │  Download from R2    │
                 │  (HTTP GET public    │
                 │   URL → /tmp)        │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │  FFprobe             │
                 │  Extract duration    │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │  FFmpeg              │
                 │  Encode 480p         │
                 │  HLS variant         │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │  FFmpeg              │
                 │  Encode 720p         │
                 │  HLS variant         │
                 └──────────┬───────────┘
                           ▼
                ┌──────────────────────┐
                │ Generate master      │
                │ playlist.m3u8        │
                │ (references both     │
                │  480p + 720p)        │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Upload HLS to R2     │
                │ • v0/playlist.m3u8   │
                │ • v0/segment_*.ts    │
                │ • v1/playlist.m3u8   │
                │ • v1/segment_*.ts    │
                │ • playlist.m3u8      │
                │   (master)           │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ UPDATE videos SET    │
                │  hls_url = '...',    │
                │  hls_status = READY, │
                │  duration_seconds    │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ Cleanup /tmp files   │
                └──────────────────────┘
```

---

## HLS Output Structure on R2

After transcoding, the following file tree is uploaded back to R2:

```
videos/<tenant-id>/hls/<video-id>/
├── playlist.m3u8              ◄── Master playlist (adaptive bitrate)
├── v0/                        ◄── 480p variant
│   ├── playlist.m3u8
│   ├── segment_000.ts
│   ├── segment_001.ts
│   └── ...
└── v1/                        ◄── 720p variant
    ├── playlist.m3u8
    ├── segment_000.ts
    ├── segment_001.ts
    └── ...
```

The master `playlist.m3u8` looks like:

```
#EXTM3U
#EXT-X-VERSION:3

#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,NAME="v480"
v0/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720,NAME="v720"
v1/playlist.m3u8
```

The player (hls.js) reads this, picks the best variant for the user's bandwidth, and streams adaptively.

---

## Video Status Lifecycle

```
  ┌──────────┐     ┌────────────┐     ┌────────────┐     ┌─────────┐
  │ PENDING  │────►│ PROCESSING │────►│   READY    │     │ FAILED  │
  │          │     │            │     │            │     │         │
  │ Video    │     │ Worker     │     │ hlsUrl set │     │ Retries │
  │ created, │     │ picked up  │     │ Playable   │     │ exhaust │
  │ upload   │     │ the job    │     │ via hls.js │     │ -ed     │
  │ starting │     │            │     │            │     │         │
  └──────────┘     └────────────┘     └────────────┘     └─────────┘
                          │                                    ▲
                          │         On error                   │
                          └────────────────────────────────────┘
```

| Status | What the user sees |
|---|---|
| **PENDING** | "Uploading..." with progress bar |
| **PROCESSING** | "Preparing video — will be ready soon" |
| **READY** | Play button active, video streams via HLS |
| **FAILED** | "Processing failed" — admin can retry |

---

## Project Structure

```
self-stream-transcoding-engine/
│
├── src/
│   ├── processor/
│   │   └── transcoding.processor.ts    ◄── Core: BullMQ worker that runs the pipeline
│   │
│   ├── services/
│   │   └── r2-upload.service.ts        ◄── S3-compatible upload (presigned URLs + direct upload)
│   │
│   ├── entities/
│   │   └── video.entity.ts            ◄── TypeORM entity (minimal — extend for your domain)
│   │
│   ├── dto/
│   │   ├── upload-complete.dto.ts      ◄── DTO for the queue-transcoding endpoint
│   │   └── presigned-upload-url.dto.ts ◄── DTO for presigned upload URL generation
│   │
│   ├── enums/
│   │   ├── video-hls-status.enum.ts    ◄── PENDING | PROCESSING | READY | FAILED
│   │   └── r2-file.enum.ts            ◄── IMAGE | VIDEO file type classification
│   │
│   └── constants/
│       └── file-upload.constants.ts    ◄── Allowed MIME types and size limits
│
├── .env.example                        ◄── All required environment variables
├── LICENSE
└── README.md
```

---

## How to Use This in Your Project

### Prerequisites

Node.js >= 18, FFmpeg (`sudo apt install ffmpeg`), Redis, PostgreSQL, and an S3-compatible bucket (Cloudflare R2, AWS S3, MinIO, Backblaze B2).

### Getting Started

**1. Copy the `src/` folder into your NestJS project and adjust import paths**

**2. Install the required packages:**

```bash
npm install @nestjs/bullmq bullmq ioredis \
  @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner \
  fluent-ffmpeg fs-extra \
  class-validator class-transformer \
  typeorm @nestjs/typeorm pg
```

**3. Register the queue, processor, and services in your NestJS module:**

```typescript
// app.module.ts
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TranscodingProcessor } from './processor/transcoding.processor';
import { R2UploadService } from './services/r2-upload.service';
import { Video } from './entities/video.entity';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
      },
    }),
    BullModule.registerQueue({ name: 'video-transcoding' }),
    TypeOrmModule.forFeature([Video]),
  ],
  providers: [TranscodingProcessor, R2UploadService],
})
export class AppModule {}
```

> For TypeORM entity sync: set `synchronize: true` in your TypeORM config during development, or generate and run a migration in production to create the `videos` table.

**4. Copy `.env.example` to `.env` and fill in your R2/Redis/DB credentials**

**5. Configure your Cloudflare R2 bucket:**

- **Public access**: The transcoding worker downloads the original uploaded video via a plain HTTP GET. Your R2 bucket (or at minimum the `videos/` path) must have public read access enabled, otherwise the download will fail.
- **CORS**: For presigned URL browser uploads to work, configure CORS on your R2 bucket:

```json
[
  {
    "AllowedOrigins": ["https://your-frontend-domain.com"],
    "AllowedMethods": ["PUT", "POST"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

**6. Implement the `POST /queue-transcoding` endpoint in your own API**

This endpoint is **not included in this repo** — you need to implement it. It should:
1. Create or update the video record in your database with `hlsStatus = PROCESSING`
2. Enqueue a job on the `video-transcoding` BullMQ queue

```typescript
// Example using BullMQ's Queue directly
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('video-transcoding') private transcodingQueue: Queue) {}

async queueTranscoding(videoId: string, key: string, tenantId: string) {
  await this.videoRepository.update({ id: videoId }, { hlsStatus: VideoHlsStatus.PROCESSING });
  await this.transcodingQueue.add('transcode', { videoId, key, tenantId });
}
```

**7. Play the video on the frontend**

Once `hlsStatus` becomes `READY`, use the `hlsUrl` from the database with **hls.js**:

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<video id="video" controls></video>
<script>
  const video = document.getElementById('video');
  const hlsUrl = 'YOUR_HLS_URL_FROM_DB'; // e.g. https://pub-xxx.r2.dev/.../playlist.m3u8

  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS support (Safari)
    video.src = hlsUrl;
  }
</script>
```

---

## FFmpeg Encoding Profiles

The engine encodes two variants sequentially to keep peak memory low — safe to run on small, cheap instances:

| Variant | Resolution | Video Bitrate | Max Rate | Buffer | Audio |
|---|---|---|---|---|---|
| **v480** | 854 x 480 | 1250 kbps | 1500 kbps | 3000 kb | AAC 128k |
| **v720** | 1280 x 720 | 3000 kbps | 3500 kbps | 7000 kb | AAC 128k |

Key FFmpeg flags and why they matter for cost:

| Flag | Value | Why |
|---|---|---|
| `-preset` | `veryfast` | Encodes fast, keeping server time per job low |
| `-threads` | `2` | Limits CPU per job — lets one server handle multiple concurrent jobs safely |
| `-profile:v high -level 4.0` | — | Broad device compatibility — no re-encoding needed client-side |
| `-hls_time` | `6` | 6-second segments — standard for smooth adaptive streaming |

Want to add 1080p? Just add another `encodeVariant()` call with `1920x1080` resolution.

---

## Why Cloudflare R2 for Storage

R2 was chosen specifically because it eliminates the bandwidth bill — the hidden cost that makes other cloud storage expensive at scale:

| Provider | Storage | Egress (bandwidth) |
|---|---|---|
| **Cloudflare R2** | $0.015/GB/mo | **$0.00** |
| AWS S3 | $0.023/GB/mo | $0.09/GB |
| Backblaze B2 | $0.006/GB/mo | $0.01/GB |
| Google Cloud Storage | $0.020/GB/mo | $0.08/GB |

With R2, you pay only for storage. Every video view is free bandwidth — no matter how many times it's watched.

---

## Author

**Faheem Malik - Senior Full Stack Engineer and Solution Architect**

I specialize in building cost-efficient, production-grade software systems: scalable backends, distributed job processing, cloud infrastructure, and clean, maintainable product engineering from MVP to scale.

[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/faheemmalik11)
[![Upwork](https://img.shields.io/badge/Upwork-14A800?style=for-the-badge&logo=upwork&logoColor=white)](https://www.upwork.com/freelancers/faheemmalik)

---

## License

MIT — see [LICENSE](./LICENSE)
