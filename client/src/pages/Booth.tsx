import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import GIF from 'gif.js';

type Mode = 'normal' | 'frame' | 'boomerang';
type Phase = 'live' | 'countdown' | 'capturing' | 'uploading' | 'done';
type FacingMode = 'user' | 'environment';

const MODES: { id: Mode; icon: string; label: string }[] = [
  { id: 'normal', icon: '📸', label: 'Normal' },
  { id: 'frame', icon: '🎭', label: 'Frame' },
  { id: 'boomerang', icon: '🪃', label: 'Boomerang' },
];

const FUNNY_CAPTIONS = ['😂 SAY CHEESE', '🎉 CAUGHT ON CAMERA', '🥳 PARTY VIBES', '📸 STRIKE A POSE', '✨ ICONIC'];
const COUNTDOWN_STEP_MS = 800;
// Boomerang: capture this many live frames, ~1.1s total, then play them
// forward then backward on a loop — the classic "Instagram Boomerang"
// back-and-forth effect. See buildBoomerangSequence for the forward+reverse
// assembly and encodeBoomerangGif for how that becomes a single looping GIF.
//
// ~9fps (10 frames / 1.1s) read as a visibly choppy "flipbook" rather than
// Instagram's own smooth, video-sourced loop — bumped to ~15fps (roughly
// double the frame count over about the same total duration) to close that
// gap. Costs proportionally more client-side GIF-encoding time and a
// bigger file (roughly double both, going from 18 to 34 total GIF frames
// once forward+reverse is assembled) — still comfortably fast/small enough
// to run on a guest's own phone.
const BOOMERANG_FRAME_COUNT = 18;
const BOOMERANG_CAPTURE_INTERVAL_MS = 65;
// Playback speed of the finished loop — kept at roughly the same fraction
// of the capture interval as before (a bit faster than real-time capture),
// so the loop's overall pace feels the same even though it's now smoother.
const BOOMERANG_PLAYBACK_DELAY_MS = 55;
// Downscaled before encoding — GIF's per-frame LZW compression cost scales
// with pixel count, and this runs client-side (often on a guest's own
// phone), so keeping frames small keeps encoding fast and the file
// reasonably sized. A boomerang is a fun loop, not a keepsake print, so
// full camera resolution isn't needed here the way it is for Normal/Frame.
const BOOMERANG_MAX_WIDTH = 480;
// Same key as Upload.tsx — a name typed on either page carries over to the
// other for the same guest/browser.
const UPLOADER_STORAGE_KEY = 'g33kvault-uploader-name';

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Draws the current video frame onto a canvas at its native resolution,
// mirrored to match the front-camera preview (so the captured photo looks
// like what the guest saw, not a flipped version of it).
function grabFrame(video: HTMLVideoElement, facingMode: FacingMode): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d')!;
  if (facingMode === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function applyFrame(source: HTMLCanvasElement): HTMLCanvasElement {
  const border = Math.round(source.width * 0.035);
  const captionHeight = Math.round(source.height * 0.12);
  const canvas = document.createElement('canvas');
  canvas.width = source.width + border * 2;
  canvas.height = source.height + border * 2 + captionHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f5f5f0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, border, border);
  ctx.fillStyle = '#161616';
  ctx.font = `bold ${Math.round(captionHeight * 0.4)}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const caption = FUNNY_CAPTIONS[Math.floor(Math.random() * FUNNY_CAPTIONS.length)];
  ctx.fillText(caption, canvas.width / 2, border * 2 + source.height + captionHeight / 2);
  return canvas;
}

function downscaleCanvas(source: HTMLCanvasElement, maxWidth: number): HTMLCanvasElement {
  if (source.width <= maxWidth) return source;
  const scale = maxWidth / source.width;
  const canvas = document.createElement('canvas');
  canvas.width = maxWidth;
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Forward frames, then the reverse of everything *except* the first and
// last frame — playing all of frames again in reverse would pause/hold
// visibly at both turnarounds (first→last→first, each held for a full
// frame twice); dropping those two endpoints on the way back makes the
// loop read as one continuous back-and-forth motion instead.
function buildBoomerangSequence(frames: HTMLCanvasElement[]): HTMLCanvasElement[] {
  const reversed = frames.slice(1, -1).reverse();
  return [...frames, ...reversed];
}

function encodeBoomerangGif(frames: HTMLCanvasElement[]): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // /gif.worker.js is a plain static copy of gif.js's own worker bundle
    // in client/public — gif.js instantiates it via `new Worker(scriptURL)`
    // directly (a bare string, not a bundler import it can resolve itself),
    // so it has to be served as-is rather than pulled in as a module.
    const gif = new GIF({ workers: 2, quality: 10, workerScript: '/gif.worker.js', repeat: 0 });
    frames.forEach((frame) => gif.addFrame(frame, { delay: BOOMERANG_PLAYBACK_DELAY_MS, copy: true }));
    gif.on('finished', (blob: Blob) => resolve(blob));
    gif.on('abort', () => reject(new Error('GIF encoding aborted')));
    gif.render();
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Always applied last, after any mode-specific processing (Frame's
// border, Event's bottom banner) — so it lands in the upper-left corner
// of the *final* exported image regardless of what other effects changed
// the canvas's size, and stacks independently on top of Event mode's own
// banner rather than being covered by it. No backing card behind the
// logo (just a drop-shadow) — same treatment as the slideshow's event
// image overlay, which also sits directly on its background.
function applyEventWatermark(source: HTMLCanvasElement, logo: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0);

  const margin = Math.round(source.width * 0.03);
  const maxLogoWidth = source.width * 0.18;
  const maxLogoHeight = source.height * 0.18;
  // Capped at 1 — never upscale the admin's source logo file past its own
  // native resolution, same reasoning as not blowing up a low-res photo.
  const logoScale = Math.min(maxLogoWidth / logo.naturalWidth, maxLogoHeight / logo.naturalHeight, 1);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowBlur = Math.round(source.width * 0.012);
  ctx.shadowOffsetY = Math.round(source.width * 0.004);
  ctx.drawImage(logo, margin, margin, logo.naturalWidth * logoScale, logo.naturalHeight * logoScale);
  ctx.restore();

  return canvas;
}

function canvasToFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Capture failed'));
        return;
      }
      resolve(new File([blob], name, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  });
}

async function uploadFile(file: File, uploader: string): Promise<boolean> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('source', 'booth');
  if (uploader.trim()) {
    formData.append('uploader', uploader.trim());
  }
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    return res.ok;
  } catch {
    return false;
  }
}

export default function Booth() {
  const [mode, setMode] = useState<Mode>('normal');
  const [facingMode, setFacingMode] = useState<FacingMode>('user');
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [phase, setPhase] = useState<Phase>('live');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [resultThumbs, setResultThumbs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  // Text shown by .booth-status during the 'capturing' phase — varies by
  // mode/step (Boomerang has two: capturing live frames, then encoding
  // them into a GIF, which can take a moment on a slower phone).
  const [captureStatus, setCaptureStatus] = useState('');
  const [uploaderName, setUploaderName] = useState(
    () => localStorage.getItem(UPLOADER_STORAGE_KEY) ?? ''
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Preloaded once eventImageUrl is known so drawImage() has something
  // ready at capture time — a canvas can't draw an image that hasn't
  // finished loading yet. null means "none set (or not loaded yet)",
  // in which case the watermark step is skipped entirely.
  const eventLogoRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (uploaderName) {
      localStorage.setItem(UPLOADER_STORAGE_KEY, uploaderName);
    } else {
      localStorage.removeItem(UPLOADER_STORAGE_KEY);
    }
  }, [uploaderName]);

  useEffect(() => {
    function loadEventLogo(url: string | null) {
      if (!url) {
        eventLogoRef.current = null;
        return;
      }
      const img = new Image();
      img.onload = () => {
        eventLogoRef.current = img;
      };
      img.onerror = () => {
        eventLogoRef.current = null;
      };
      img.src = url;
    }

    fetch('/api/config')
      .then((r) => r.json())
      .then((data: { eventImageUrl: string | null }) => loadEventLogo(data.eventImageUrl));

    const socket: Socket = io({ path: '/socket.io' });
    socket.on('config:updated', (data: { eventImageUrl: string | null }) => loadEventLogo(data.eventImageUrl));

    return () => {
      socket.disconnect();
    };
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function startCamera(nextFacingMode: FacingMode) {
    stopCamera();
    setCameraReady(false);
    setCameraError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        // Most browsers (Safari on iOS in particular) don't expose this API
        // at all on an insecure (non-HTTPS, non-localhost) origin, so this
        // fires before any permission prompt ever appears.
        setCameraError('Camera access needs HTTPS — this page was loaded over an insecure connection.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacingMode } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('getUserMedia failed:', err);
      const name = err instanceof Error ? err.name : 'UnknownError';
      setCameraError(`Could not access the camera (${name}). Check permissions and try again.`);
    }
  }

  useEffect(() => {
    startCamera(facingMode);
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode]);

  function triggerFlash() {
    setFlash(true);
    setTimeout(() => setFlash(false), 150);
  }

  async function startCapture() {
    if (!videoRef.current || phase !== 'live' || !cameraReady) return;
    setErrorMsg('');
    setPhase('countdown');

    for (const n of [3, 2, 1]) {
      setCountdown(n);
      await wait(COUNTDOWN_STEP_MS);
    }
    setCountdown(null);
    setPhase('capturing');

    let files: File[];
    let thumbs: string[];

    if (mode === 'boomerang') {
      setCaptureStatus('🪃 Boomerang!');
      triggerFlash();
      const frames: HTMLCanvasElement[] = [];
      for (let i = 0; i < BOOMERANG_FRAME_COUNT; i++) {
        if (!videoRef.current) break;
        let canvas = grabFrame(videoRef.current, facingMode);
        canvas = downscaleCanvas(canvas, BOOMERANG_MAX_WIDTH);
        // Every mode, always — not gated behind a setting, per how this
        // was asked for. Silently skipped when no event image is set.
        // Applied per-frame here so it's baked into the whole loop, not
        // just a single still.
        if (eventLogoRef.current) canvas = applyEventWatermark(canvas, eventLogoRef.current);
        frames.push(canvas);
        if (i < BOOMERANG_FRAME_COUNT - 1) await wait(BOOMERANG_CAPTURE_INTERVAL_MS);
      }

      setCaptureStatus('🌀 Encoding…');
      const blob = await encodeBoomerangGif(buildBoomerangSequence(frames));
      files = [new File([blob], `booth-boomerang-${Date.now()}.gif`, { type: 'image/gif' })];
      thumbs = [await blobToDataUrl(blob)];
    } else {
      triggerFlash();
      let canvas = grabFrame(videoRef.current, facingMode);
      if (mode === 'frame') canvas = applyFrame(canvas);
      // Every mode, always — not gated behind a setting, per how this was
      // asked for. Silently skipped when no event image is set.
      if (eventLogoRef.current) canvas = applyEventWatermark(canvas, eventLogoRef.current);
      files = [await canvasToFile(canvas, `booth-${Date.now()}.jpg`)];
      thumbs = [canvas.toDataURL('image/jpeg', 0.6)];
    }

    setCaptureStatus('');
    setPhase('uploading');
    const results = await Promise.all(files.map((f) => uploadFile(f, uploaderName)));

    if (results.every(Boolean)) {
      setResultThumbs(thumbs);
      setPhase('done');
      setTimeout(() => {
        setPhase('live');
        setResultThumbs([]);
      }, 3000);
    } else {
      setErrorMsg('Upload failed — check your connection and try again.');
      setPhase('live');
    }
  }

  const busy = phase !== 'live';

  return (
    <div className="booth-page">
      <h1 className="brand booth-brand">
        <a href="/" className="brand-link">
          g33k<span>Vault</span> booth
        </a>
      </h1>

      <input
        type="text"
        className="booth-uploader-input"
        placeholder="Your name (optional)"
        maxLength={40}
        value={uploaderName}
        onChange={(e) => setUploaderName(e.target.value)}
        disabled={busy}
      />

      <div className="booth-viewport">
        {cameraError ? (
          <div className="booth-camera-error">
            <p>{cameraError}</p>
            <button className="btn btn-primary" onClick={() => startCamera(facingMode)}>
              Retry
            </button>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={() => setCameraReady(true)}
            className={`booth-video ${facingMode === 'user' ? 'mirrored' : ''}`}
          />
        )}

        {flash && <div className="booth-flash" />}

        {countdown !== null && <div className="booth-countdown">{countdown}</div>}

        {phase === 'capturing' && captureStatus && <div className="booth-status">{captureStatus}</div>}
        {phase === 'uploading' && <div className="booth-status">Uploading…</div>}

        {phase === 'done' && (
          <div className="booth-success">
            <p>✅ Added to the wall!</p>
            <div className="booth-success-thumbs">
              {resultThumbs.map((t, i) => (
                <img key={i} src={t} alt="" />
              ))}
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setPhase('live');
                setResultThumbs([]);
              }}
            >
              Take another
            </button>
          </div>
        )}
      </div>

      {errorMsg && <p className="error-msg">{errorMsg}</p>}

      <div className="booth-mode-row">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`booth-mode-btn ${mode === m.id ? 'active' : ''}`}
            onClick={() => setMode(m.id)}
            disabled={busy}
          >
            <span className="booth-mode-icon">{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>

      <div className="booth-controls">
        <button
          className="booth-flip-btn"
          onClick={() => setFacingMode((f) => (f === 'user' ? 'environment' : 'user'))}
          disabled={busy}
          aria-label="Switch camera"
          title="Switch camera"
        >
          🔄
        </button>

        <button
          className="booth-shutter"
          onClick={startCapture}
          disabled={busy || !cameraReady || !!cameraError}
          aria-label="Take photo"
          title="Take photo"
        />

        <a href="/upload" className="booth-secondary-link">
          Upload instead
        </a>
      </div>
    </div>
  );
}
