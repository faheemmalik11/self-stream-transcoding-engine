export const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export const ALLOWED_VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
] as const;

export const ALLOWED_ALL_MIMES = [
  ...ALLOWED_IMAGE_MIMES,
  ...ALLOWED_VIDEO_MIMES,
] as const;

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
export const MAX_VIDEO_SIZE = 1024 * 1024 * 1024; // 1 GB
export const MAX_FILE_SIZE = MAX_VIDEO_SIZE; // 1 GB general cap
