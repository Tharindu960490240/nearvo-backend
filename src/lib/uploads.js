// Profile photo uploads.
// - On Vercel (or whenever BLOB_READ_WRITE_TOKEN is set): stored in Vercel Blob, because a
//   serverless function can't keep files on its own disk.
// - Locally: stored in UPLOAD_DIR/public and served at /uploads.
// - On Vercel without Blob connected: the API still starts, but photo uploads return a clear error
//   (Vercel's disk is read-only, so files can't be saved there).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { del, put } from '@vercel/blob';

export const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
export const PUBLIC_DIR = path.join(UPLOAD_DIR, 'public');

/** True when photos are kept on this machine's disk (local development / your own server). */
export const useDisk = !useBlob && !process.env.VERCEL && (() => {
  try { fs.mkdirSync(PUBLIC_DIR, { recursive: true }); return true; } catch { return false; }
})();
if (!useBlob && !useDisk) {
  console.warn('Photo uploads are off: connect Vercel Blob (BLOB_READ_WRITE_TOKEN) to turn them on.');
}

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
};
const newName = (mime) => crypto.randomBytes(16).toString('hex') + EXT[mime];

export const photoUpload = multer({
  // Note: the destination is a function so multer never tries to create folders at start-up.
  storage: !useDisk
    ? multer.memoryStorage()
    : multer.diskStorage({ destination: (_req, _file, cb) => cb(null, PUBLIC_DIR), filename: (_req, file, cb) => cb(null, newName(file.mimetype)) }),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 }, // Vercel limits request bodies to about 4.5 MB
  fileFilter: (_req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(Object.assign(new Error('Photo must be a JPG, PNG or WebP image'), { status: 400, expose: true })),
});

function headBytes(file) {
  if (file.buffer) return file.buffer.subarray(0, 12);
  const fd = fs.openSync(file.path, 'r');
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  return head;
}

/** Checks the file really is the image type it claims, then stores it. Returns the public URL, or null if invalid. */
export async function savePhoto(file) {
  if (!useBlob && !useDisk) {
    throw Object.assign(new Error("Photo uploads aren't set up on this server yet. Please try again later."), { status: 503, expose: true });
  }
  if (!SIGNATURES[file.mimetype]?.(headBytes(file))) {
    if (file.path) fs.rmSync(file.path, { force: true });
    return null;
  }
  if (useBlob) {
    const blob = await put(`photos/${newName(file.mimetype)}`, file.buffer, { access: 'public', contentType: file.mimetype });
    return blob.url;
  }
  return `/uploads/${file.filename}`;
}

/** Deletes a previously saved photo (Blob URL or local /uploads path). */
export async function removePhoto(url) {
  if (!url) return;
  try {
    if (/^https?:\/\//.test(url)) {
      if (useBlob) await del(url);
    } else if (url.startsWith('/uploads/')) {
      const full = path.resolve(PUBLIC_DIR, url.slice('/uploads/'.length));
      if (full.startsWith(PUBLIC_DIR + path.sep)) fs.rmSync(full, { force: true });
    }
  } catch (err) {
    console.error('Could not delete old photo:', err.message);
  }
}
