# Self-Stream Transcoding Engine

**Self-hosted video streaming infrastructure. Upload, transcode to HLS, and stream, All you pay is the cost of an EC2 instance(Or whichever hosting platform you use).**

We replaced Cloudflare Stream (billed per minute of video stored + delivered) with a custom pipeline that runs entirely on our own infrastructure. The result: the same upload-to-playback experience at a fraction of the cost, especially at bulk scale.

This repo contains the **transcoding engine** the core worker that powers the pipeline. It downloads uploaded videos from S3-compatible object storage, transcodes them into multi-variant HLS using FFmpeg, uploads the HLS segments back, and updates your database with the stream URL.

---

## What it solves

Managed video platforms (Cloudflare Stream, Mux, AWS MediaConvert) charge **per minute of video stored and delivered**. When you're uploading hundreds of videos per month, costs add up fast.

We needed:
- Direct upload to cheap object storage (Cloudflare R2)
- Background transcoding that doesn't block the user
- Adaptive bitrate streaming (HLS) for any device
- Real-time status tracking (uploading → processing → ready)
- All of this for **just the cost of running an EC2/VPS instance**

---

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| **Queue** | BullMQ + Redis | Reliable job queue with retries & backoff |
| **Transcoding** | FFmpeg (libx264 + AAC) | Video encoding to multi-variant HLS |
| **Storage** | Cloudflare R2 (S3-compatible) | Object storage with zero egress fees |
| **Upload** | AWS SDK v3 (S3Client) | Presigned URLs for direct browser-to-R2 upload |
| **Database** | PostgreSQL + TypeORM | Video record + status tracking |
| **Framework** | NestJS | Backend API + worker host |

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
  ┌──────────────┐
  │ POST /queue- │
  │ transcoding  │
  └──────┬───────┘
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
                   ┌────────┴────────┐
                   ▼                 ▼
          ┌───────────────┐  ┌───────────────┐
          │ FFmpeg        │  │ FFmpeg        │
          │ Encode 480p   │  │ Encode 720p   │
          │ HLS variant   │  │ HLS variant   │
          │ (sequential)  │  │ (sequential)  │
          └───────┬───────┘  └──────┬────────┘
                  │                 │
                  └────────┬────────┘
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

1. Copy the `src/` folder into your NestJS project and adjust import paths
2. Install the required packages: `@nestjs/bullmq`, `bullmq`, `ioredis`, `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`, `fluent-ffmpeg`, `fs-extra`, `class-validator`, `class-transformer`, `typeorm`, `@nestjs/typeorm`
3. Register `TranscodingProcessor` and `R2UploadService` as providers in your NestJS module, and register the `video-transcoding` BullMQ queue
4. Configure BullMQ with your Redis connection in your root `AppModule`
5. Copy `.env.example` to `.env` and fill in your R2/Redis/DB credentials
6. When a video upload completes, update its status to `PROCESSING` and add a job to the `video-transcoding` queue with `{ videoId, key, tenantId }`
7. Once the job finishes and status becomes `READY`, use the `hlsUrl` from the database with **hls.js** on the frontend to play the video

---

## FFmpeg Encoding Profiles

The engine encodes two variants sequentially (to keep memory low on small instances):

| Variant | Resolution | Video Bitrate | Max Rate | Buffer | Audio |
|---|---|---|---|---|---|
| **v480** | 854 x 480 | 1250 kbps | 1500 kbps | 3000 kb | AAC 128k |
| **v720** | 1280 x 720 | 3000 kbps | 3500 kbps | 7000 kb | AAC 128k |

Common FFmpeg flags used:
- `-preset veryfast` — fast encoding, slightly larger files (good trade-off for server cost)
- `-profile:v high -level 4.0` — broad device compatibility
- `-hls_time 6` — 6-second segments (standard for adaptive streaming)
- `-threads 2` — limits CPU usage per job (safe for shared instances)

Want to add 1080p? Just add another `encodeVariant()` call with `1920x1080` resolution.

---

## Cost Comparison

Managed platforms like Cloudflare Stream charge per minute stored and per minute delivered. At scale, this grows linearly with your library size.

With this engine, your only recurring costs are **object storage** (R2 is $0.015/GB/mo with zero egress fees) and **your server** (~$10-40/mo for an EC2/VPS). The storage cost is negligible and the server cost stays flat no matter how many videos you add. Beyond ~50 videos, self-hosting wins — and the gap only widens from there.

---

## Author

**Faheem Malik - Senior Full Stack Engineer and solution architect**

I specialize in building cost-efficient, production-grade software systems: scalable backends, distributed job processing, cloud infrastructure, and clean, maintainable product engineering from MVP to scale.


[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/faheemmalik11)
[![Upwork](https://img.shields.io/badge/Upwork-14A800?style=for-the-badge&logo=upwork&logoColor=white)](https://www.upwork.com/freelancers/faheemmalik)

---

## License

MIT — see [LICENSE](./LICENSE)
