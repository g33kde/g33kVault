import fs from 'fs';
import convert from 'heic-convert';

// Converts a HEIC/HEIF file on disk to JPEG at destPath, then removes the
// source file. Runs in WASM (no native compile step, works unmodified on
// any architecture including a Raspberry Pi's ARM CPU).
export async function convertHeicToJpeg(srcPath: string, destPath: string): Promise<void> {
  const inputBuffer = fs.readFileSync(srcPath);
  const outputBuffer = await convert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
  fs.writeFileSync(destPath, outputBuffer);
  fs.unlinkSync(srcPath);
}
