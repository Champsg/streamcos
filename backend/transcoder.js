const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Hovod-inspired adaptive bitrate transcoding ladder
const RENDITIONS = [
  { quality: '720p', width: 1280, height: 720, videoBitrate: '2500k', audioBitrate: '128k', maxrate: '2800k', bufsize: '5000k' },
  { quality: '480p', width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k', maxrate: '1600k', bufsize: '3000k' },
  { quality: '360p', width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k', maxrate: '900k', bufsize: '1800k' }
];

const SEGMENT_DURATION = 6; // Hovod standard: 6-second segments

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
    proc.on('error', err => reject(err));
  });
}

/**
 * Transcodes an input video into a multi-bitrate HLS package (master.m3u8 + 720p, 480p, 360p).
 * Inspired by Synapsr/Hovod HLS worker pipeline.
 */
async function transcodeToHLS(inputPath, outputRootDir, videoId, onProgress) {
  const hlsDir = path.join(outputRootDir, videoId);
  fs.mkdirSync(hlsDir, { recursive: true });

  const activeRenditions = [];

  // 1. Primary High-Quality Rendition: Attempt lightning-fast stream-copy first
  const highQualityDir = path.join(hlsDir, '720p');
  fs.mkdirSync(highQualityDir, { recursive: true });
  let copySucceeded = false;
  try {
    if (onProgress) onProgress('Fast-slicing HLS stream...');
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(highQualityDir, 'segment_%03d.ts'),
      path.join(highQualityDir, 'index.m3u8')
    ]);
    activeRenditions.push({ quality: '720p', width: 1280, height: 720, videoBitrate: '2500k' });
    copySucceeded = true;
  } catch (copyErr) {
    console.warn('Stream copy failed, falling back to ultrafast re-encode:', copyErr.message);
  }

  // 2. If copy failed, re-encode with ultrafast preset
  if (!copySucceeded) {
    const r = RENDITIONS[0];
    try {
      await runFfmpeg([
        '-y', '-i', inputPath,
        '-vf', `scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
        '-c:a', 'aac', '-b:a', '128k',
        '-f', 'hls', '-hls_time', String(SEGMENT_DURATION), '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(highQualityDir, 'segment_%03d.ts'),
        path.join(highQualityDir, 'index.m3u8')
      ]);
      activeRenditions.push(r);
    } catch (e) {
      console.warn('High quality encode failed:', e.message);
    }
  }

  // 3. Fast Mobile Rendition (480p) using ultrafast preset
  const mobileDir = path.join(hlsDir, '480p');
  fs.mkdirSync(mobileDir, { recursive: true });
  try {
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-vf', 'scale=w=854:h=480:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '96k',
      '-f', 'hls', '-hls_time', String(SEGMENT_DURATION), '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(mobileDir, 'segment_%03d.ts'),
      path.join(mobileDir, 'index.m3u8')
    ]);
    activeRenditions.push({ quality: '480p', width: 854, height: 480, videoBitrate: '1400k' });
  } catch (mobileErr) {
    console.warn('Mobile rendition failed, skipping:', mobileErr.message);
  }

  // If multi-bitrate failed, fallback to single direct HLS
  if (activeRenditions.length === 0) {
    const singleDir = path.join(hlsDir, 'default');
    fs.mkdirSync(singleDir, { recursive: true });
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
      '-f', 'hls', '-hls_time', String(SEGMENT_DURATION), '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(singleDir, 'segment_%03d.ts'),
      path.join(singleDir, 'index.m3u8')
    ]);
    activeRenditions.push({ quality: 'default', width: 640, height: 360, videoBitrate: '1000k' });
  }

  // Generate Master Playlist (master.m3u8)
  let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const r of activeRenditions) {
    const bandwidth = parseInt(r.videoBitrate) * 1000 + 128000;
    masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height},NAME="${r.quality}"\n`;
    masterContent += `${r.quality}/index.m3u8\n`;
  }

  const masterPlaylistPath = path.join(hlsDir, 'master.m3u8');
  fs.writeFileSync(masterPlaylistPath, masterContent, 'utf-8');

  // Extract a high-res video poster thumbnail from the 2nd second
  const thumbnailPath = path.join(hlsDir, 'poster.jpg');
  try {
    await extractThumbnail(inputPath, thumbnailPath, 2);
  } catch (e) {
    console.warn('Auto-thumbnail extraction skipped:', e.message);
  }

  return {
    hlsUrl: `/uploads/hls/${videoId}/master.m3u8`,
    posterUrl: fs.existsSync(thumbnailPath) ? `/uploads/hls/${videoId}/poster.jpg` : null,
    renditions: activeRenditions.map(r => r.quality)
  };
}

/**
 * Extracts a frame from a video as a JPEG poster image.
 */
async function extractThumbnail(videoPath, outputPath, seekSeconds = 1) {
  try {
    await runFfmpeg(['-y', '-ss', String(seekSeconds), '-i', videoPath, '-vframes', '1', '-q:v', '2', outputPath]);
  } catch (err) {
    // Fallback: grab the very first frame if video duration is shorter than seek time
    await runFfmpeg(['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', outputPath]);
  }
}

module.exports = {
  transcodeToHLS,
  extractThumbnail,
  RENDITIONS
};
