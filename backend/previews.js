'use strict';

/**
 * Server-side preview clips.
 *
 * The old behaviour handed a paid title's full stream to a "preview" token and
 * relied on browser JavaScript to stop at 45 seconds — anyone could copy the
 * URL and watch the whole film. Now a preview is a *separate, shorter file*
 * rendered by ffmpeg from the first 45 seconds, and preview tokens are only
 * valid for that file.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREVIEW_SECONDS = Number(process.env.STREAMCOS_PREVIEW_SECONDS || 45);
const PREVIEW_DIR = 'previews';

function safeId(videoId) {
  return String(videoId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80) || 'title';
}

function fileName(videoId) {
  return safeId(videoId) + '.mp4';
}

function relPath(videoId) {
  return PREVIEW_DIR + '/' + fileName(videoId);
}

function urlPath(videoId) {
  return '/uploads/' + relPath(videoId);
}

function runFfmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch (e) {}
      reject(new Error('ffmpeg preview timed out'));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited ' + code + ': ' + stderr.slice(-300)));
    });
  });
}

/** Renders `seconds` of `sourcePath` into a 640px-wide H.264 MP4. */
async function generate(sourcePath, outPath, seconds = PREVIEW_SECONDS) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const partial = outPath.replace(/\.mp4$/, '') + '.' + process.pid + '.part.mp4';
  try {
    await runFfmpeg([
      '-y',
      '-ss', '0',
      '-t', String(seconds),
      '-i', sourcePath,
      '-vf', 'scale=w=640:h=-2:force_original_aspect_ratio=decrease',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '27',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      partial
    ]);
    fs.rmSync(outPath, { force: true }); // Windows rename cannot replace in place
    fs.renameSync(partial, outPath);
  } finally {
    try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (e) {}
  }
  return outPath;
}

/**
 * Returns { url, generated } for a title, rendering on first use and again
 * whenever the source file changes (replace a film's video and its preview
 * must not stay stale).
 * Throws if ffmpeg is unavailable or the source cannot be read.
 */
async function ensure(videoId, sourcePath, uploadsDir) {
  const outPath = path.join(uploadsDir, relPath(videoId));
  const metaPath = outPath.replace(/\.mp4$/i, '.json');

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { url: urlPath(videoId), generated: false };
    }
    if (fs.existsSync(metaPath)) {
      try {
        const previous = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const stat = fs.statSync(sourcePath);
        if (previous.source === path.basename(sourcePath) &&
            previous.size === stat.size &&
            previous.mtimeMs === Math.round(stat.mtimeMs) &&
            previous.seconds === PREVIEW_SECONDS) {
          return { url: urlPath(videoId), generated: false };
        }
      } catch (e) {
        // Unreadable metadata -> regenerate below.
      }
    }
  }

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('preview source is not available locally');
  }

  const stat = fs.statSync(sourcePath);
  const wanted = {
    source: path.basename(sourcePath),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    seconds: PREVIEW_SECONDS
  };

  await generate(sourcePath, outPath);
  fs.writeFileSync(metaPath, JSON.stringify(wanted), 'utf8');
  return { url: urlPath(videoId), generated: true };
}

module.exports = {
  PREVIEW_SECONDS,
  PREVIEW_DIR,
  fileName,
  relPath,
  urlPath,
  generate,
  ensure
};
