# Reels Module (Phase 1 MVP)

Generate short vertical MP4 reels from up to 3 images using FFmpeg and Cloudinary.

## Folder structure

```
reels/
  templates/          # JSON template configs (add new templates here)
  config/             # Shared constants
  services/
    templateService.js
    imageInputService.js
    ffmpegService.js
    reelStorageService.js
    reelGenerateService.js

uploads/reels/
  images/             # Optional saved source images
  videos/             # Local MP4 copies after generation
  music/              # Reserved for Phase 2 background music
  temp/               # Temporary FFmpeg workspace (auto-cleaned)

services/reelsRoute.js   # HTTP routes only
```

## API

### List templates

`GET /api/reels/templates` (admin auth)

### Generate reel

`POST /api/reels/generate` (admin auth)

**JSON body**

```json
{
  "templateId": "cloth-01",
  "images": [
    "https://example.com/image1.jpg",
    "https://example.com/image2.jpg",
    "https://example.com/image3.jpg"
  ],
  "duration": 10
}
```

**Multipart**

- `templateId` (optional, default `cloth-01`)
- `duration` (optional)
- `images` files (max 3)

**Response**

```json
{
  "success": true,
  "video": "https://res.cloudinary.com/.../reels/....mp4",
  "templateId": "cloth-01",
  "duration": 10,
  "message": "Reel generated successfully."
}
```

## Template JSON

Add a new file in `reels/templates/your-id.json`:

```json
{
  "id": "your-id",
  "name": "My Template",
  "duration": 10,
  "aspectRatio": "9:16",
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "transitionDuration": 0.5,
  "segments": [
    { "index": 0, "duration": 3, "animation": "zoom-in" },
    { "index": 1, "duration": 3, "animation": "fade" },
    { "index": 2, "duration": 4, "animation": "zoom-out" }
  ]
}
```

Supported animations: `zoom-in`, `zoom-out`, `fade`, `static`.

## Phase 2 (planned)

Same module — add services for:

- AI script generation
- AI voice-over
- Background music mix

No route changes required; extend `reelGenerateService.js`.

## Server requirements

- FFmpeg must be installed (`ffmpeg` on PATH or `FFMPEG_PATH`)
- Render build installs FFmpeg via `render.yaml`
- Videos upload to Cloudinary folder `CLOUDINARY_REELS_FOLDER` (default: `reels`)
