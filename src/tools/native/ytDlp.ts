/**
 * yt-dlp download tool.
 *
 * Wraps yt-dlp as a subprocess. Supports:
 *   - Video download (mp4, best quality or specified)
 *   - Audio-only download (mp3/m4a via ffmpeg post-processing)
 *   - Playlist download
 *   - Metadata/info fetch (no download)
 *   - Subtitle download
 *   - Thumbnail extraction
 *
 * yt-dlp binary location: YTDLP_PATH env var, or auto-detected from PATH
 * and common install locations. ffmpeg similarly via FFMPEG_PATH.
 *
 * Output directory: YTDLP_DOWNLOAD_DIR env var, or ~/Downloads/Carter.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const COMMON_YTDLP_PATHS = [
  process.env.YTDLP_PATH,
  "yt-dlp",
  "yt-dlp.exe",
  "C:\\yt-dlp\\yt-dlp.exe",
  path.join(homedir(), "scoop", "shims", "yt-dlp.exe"),
  path.join(homedir(), "AppData", "Local", "Programs", "yt-dlp", "yt-dlp.exe"),
  "C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe",
].filter(Boolean) as string[];

const COMMON_FFMPEG_PATHS = [
  process.env.FFMPEG_PATH,
  "ffmpeg",
  "ffmpeg.exe",
  "C:\\ffmpeg\\bin\\ffmpeg.exe",
  path.join(homedir(), "scoop", "shims", "ffmpeg.exe"),
  "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
].filter(Boolean) as string[];

function findBinary(candidates: string[]): string | null {
  for (const p of candidates) {
    if (!p) continue;
    if (p.includes("/") || p.includes("\\")) {
      if (existsSync(p)) return p;
    } else {
      // bare name — assume it's on PATH, return as-is and let spawn fail gracefully
      return p;
    }
  }
  return null;
}

function getYtDlp(): string {
  const bin = findBinary(COMMON_YTDLP_PATHS);
  if (!bin) throw new Error(
    "yt-dlp not found. Install it:\n" +
    "  winget install yt-dlp  (or: choco install yt-dlp)\n" +
    "  Then set YTDLP_PATH in .env if needed."
  );
  return bin;
}

function getOutputDir(): string {
  const dir = process.env.YTDLP_DOWNLOAD_DIR
    ?? path.join(homedir(), "Downloads", "Carter");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export type DownloadFormat = "video" | "audio" | "thumbnail" | "subtitles" | "info";

export interface DownloadOptions {
  url: string;
  format?: DownloadFormat;
  quality?: "best" | "worst" | "720" | "1080" | "480" | "360";
  audioFormat?: "mp3" | "m4a" | "opus" | "wav";
  playlistItems?: string;   // e.g. "1-5" or "1,3,5"
  subtitleLangs?: string;   // e.g. "en,de"
  outputDir?: string;
}

export interface DownloadResult {
  success: boolean;
  files: string[];
  info?: Record<string, unknown>;
  log: string;
}

function runYtDlp(args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const bin = getYtDlp();
    const child = spawn(bin, args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", d => stdout.push(d));
    child.stderr.on("data", d => stderr.push(d));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("close", code => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf-8");
      const err = Buffer.concat(stderr).toString("utf-8");
      if (code !== 0) reject(new Error(`yt-dlp exited ${code}:\n${err || out}`));
      else resolve({ stdout: out, stderr: err });
    });
    child.on("error", err => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(
          "yt-dlp binary not found. Install with: winget install yt-dlp\n" +
          "Or set YTDLP_PATH in .env"
        ));
      } else reject(err);
    });
  });
}

/** Fetch video/playlist metadata without downloading. */
export async function getInfo(url: string): Promise<Record<string, unknown>> {
  const { stdout } = await runYtDlp(["--dump-json", "--no-playlist", url], 30_000);
  // May be multiple JSON lines for playlists — take first
  const line = stdout.trim().split("\n")[0];
  return JSON.parse(line);
}

/** Download video, audio, subtitles, or thumbnail. Returns paths of created files. */
export async function download(opts: DownloadOptions): Promise<DownloadResult> {
  const outputDir = opts.outputDir ?? getOutputDir();
  const args: string[] = [];

  const ffmpeg = findBinary(COMMON_FFMPEG_PATHS);
  if (ffmpeg && (ffmpeg.includes("/") || ffmpeg.includes("\\"))) {
    args.push("--ffmpeg-location", path.dirname(ffmpeg));
  }

  // Output template
  args.push("-o", path.join(outputDir, "%(title)s.%(ext)s"));

  // Print filenames of downloaded files so we can report them
  args.push("--print", "after_move:filepath");

  switch (opts.format ?? "video") {
    case "audio": {
      const af = opts.audioFormat ?? "mp3";
      args.push("-x", "--audio-format", af, "--audio-quality", "0");
      break;
    }
    case "thumbnail": {
      args.push("--write-thumbnail", "--skip-download", "--convert-thumbnails", "jpg");
      break;
    }
    case "subtitles": {
      const langs = opts.subtitleLangs ?? "en";
      args.push("--write-subs", "--write-auto-subs", "--sub-langs", langs, "--skip-download");
      break;
    }
    case "info": {
      const info = await getInfo(opts.url);
      return {
        success: true,
        files: [],
        info,
        log: `Fetched metadata for: ${info.title ?? opts.url}`,
      };
    }
    default: {
      // Video — pick format string based on quality
      const q = opts.quality ?? "best";
      if (q === "best") {
        args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best");
        args.push("--merge-output-format", "mp4");
      } else if (q === "worst") {
        args.push("-f", "worstvideo+worstaudio/worst");
      } else {
        // Specific height e.g. 720, 1080
        args.push("-f", `bestvideo[height<=${q}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${q}]`);
        args.push("--merge-output-format", "mp4");
      }
    }
  }

  // Playlist support
  if (opts.playlistItems) {
    args.push("--playlist-items", opts.playlistItems);
  } else {
    args.push("--no-playlist");
  }

  // Rate limit to be polite (10MB/s)
  args.push("--limit-rate", "10M");

  args.push(opts.url);

  const { stdout, stderr } = await runYtDlp(args, 300_000); // 5 min timeout

  // Parse downloaded file paths from --print after_move:filepath
  const files = stdout.trim().split("\n").filter(l => l && existsSync(l.trim())).map(l => l.trim());

  return {
    success: true,
    files,
    log: [stdout, stderr].filter(Boolean).join("\n").slice(0, 1000),
  };
}
