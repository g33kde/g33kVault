import fs from 'fs';
import { spawn } from 'child_process';

// Unlike heicConvert.ts (a pure-JS/WASM library, no system dependency),
// there's no realistic pure-JS way to transcode video — this shells out to
// the system `ffmpeg` binary, the same approach already used for `tar` in
// admin.ts's backup route, not an npm dependency (see CLAUDE.md's
// no-native-deps rule, which is specifically about node-gyp-compiled npm
// packages, not a system binary installed via the Dockerfile's package
// manager). Requires `ffmpeg` to be present wherever this runs — see the
// Dockerfile (`apk add ffmpeg`) and README's other deployment paths.
export function convertMpegToMp4(srcPath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y', // overwrite destPath without prompting — spawn has no stdin to answer one
      '-loglevel',
      'error',
      '-i',
      srcPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast', // favors speed over compression ratio — this may run on a Pi
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart', // moov atom up front, so the browser can start playing before the whole file's downloaded
      destPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (err) => {
      // ENOENT here specifically means ffmpeg itself isn't installed, not a
      // bad input file — worth a distinct message since that's a deployment
      // problem, not a "this particular video is corrupt" one.
      reject(
        err.message.includes('ENOENT')
          ? new Error('ffmpeg is not installed on this server')
          : err
      );
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        fs.unlink(srcPath, () => {});
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}
