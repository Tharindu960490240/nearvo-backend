import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
export const PUBLIC_DIR = path.join(UPLOAD_DIR, 'public');   // profile photos, served at /uploads
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// Check the file's first bytes really match its claimed type.
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};

function makeUploader(dir, allowed) {
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) =>
      allowed.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error(`File must be ${allowed.map((m) => EXT[m].slice(1).toUpperCase()).join(', ')}`), { status: 400, expose: true })),
  });
}

export const photoUpload = makeUploader(PUBLIC_DIR, ['image/jpeg', 'image/png', 'image/webp']);

/** Rejects (and deletes) an uploaded file whose content doesn't match its type. */
export function verifyFileContent(file) {
  const fd = fs.openSync(file.path, 'r');
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  if (!SIGNATURES[file.mimetype]?.(head)) {
    fs.rmSync(file.path, { force: true });
    return false;
  }
  return true;
}

export function removeUpload(relPath) {
  if (!relPath) return;
  const full = path.resolve(UPLOAD_DIR, relPath);
  if (full.startsWith(UPLOAD_DIR + path.sep)) fs.rmSync(full, { force: true });
}
