# StreamCos — Video Streaming Platform

Separated Backend & Frontend architecture with **Hovod-inspired Direct Video Upload & Adaptive Bitrate HLS Transcoding**.

## Architecture

```
streamcos-source/
├── backend/
│   ├── server.js       # Node.js REST API + HTTP Byte-Range Video Streaming Server
│   ├── transcoder.js   # Hovod-style HLS Transcoding Ladder (720p/480p/360p + Master Playlist)
│   ├── data.json       # Persistent JSON store
│   ├── uploads/        # Local video storage & HLS chunks directory
│   │   ├── videos/     # Raw uploaded videos (.mp4, .mov, etc.)
│   │   ├── posters/    # Uploaded image thumbnails
│   │   └── hls/        # Adaptive HLS directories (master.m3u8 + segments)
│   └── test.js         # Comprehensive 14-assertion test suite
├── frontend/
│   ├── index.html      # Mobile-first streaming web app with Hls.js
│   ├── css/style.css   # Dark theme styles & micro-animations
│   ├── js/app.js       # Frontend controller with upload progress & HLS player
│   └── assets/         # Starter posters and app icon
├── package.json        # Start & test scripts
└── space.json          # Deployment entry config
```

## Running the App

### 1. Start Server & Stream on Your Network
```bash
npm start
```
Output will display:
- **Local:** `http://localhost:5000`
- **Network (Wi-Fi):** `http://192.168.x.x:5000` (open this on your phone or any PC on the same Wi-Fi to stream videos live from your PC!)

### 2. Run Test Suite
```bash
npm test
```
*(All 14 assertions pass, including direct upload, range streaming, and HLS transcoding).*

## Features

1. **Direct Video Upload from PC**:
   - In Owner Studio, click **"📁 Choose & Upload Video from PC"** to upload any local `.mp4`, `.mov`, `.mkv`, or `.webm`.
   - Streaming disk write prevents memory bottlenecks for large video files.
2. **Adaptive Bitrate HLS (Hovod Engine)**:
   - Slices videos via local `ffmpeg` into multi-quality HLS streams (720p, 480p, 360p).
   - Generates `master.m3u8` with `#EXT-X-STREAM-INF` bandwidth ladders.
   - Automatically extracts poster frame at 1-2s if no thumbnail is provided.
3. **Adaptive Web Player**:
   - Integrated with `hls.js` for instant playback across all browsers, smartphones, and tablets.
   - Falls back to native HLS on Safari/iOS and HTTP 206 Byte-Range streaming for standard MP4s.
4. **Local Wi-Fi Streaming**:
   - Server binds to `0.0.0.0` and displays your PC's IP address in the Owner Studio banner.
