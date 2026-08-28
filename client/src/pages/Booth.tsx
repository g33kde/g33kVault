import { useEffect, useRef, useState } from 'react';

type Mode = 'normal' | 'burst' | 'frame' | 'branded';
type Phase = 'live' | 'countdown' | 'capturing' | 'uploading' | 'done';
type FacingMode = 'user' | 'environment';

const MODES: { id: Mode; icon: string; label: string }[] = [
  { id: 'normal', icon: '📸', label: 'Normal' },
  { id: 'burst', icon: '🤪', label: 'Burst' },
  { id: 'frame', icon: '🎭', label: 'Frame' },
  { id: 'branded', icon: '🎉', label: 'Event' },
];

const FUNNY_CAPTIONS = ['😂 SAY CHEESE', '🎉 CAUGHT ON CAMERA', '🥳 PARTY VIBES', '📸 STRIKE A POSE', '✨ ICONIC'];
const BURST_SHOTS = 4;
const BURST_GAP_MS = 500;
const COUNTDOWN_STEP_MS = 800;

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

function applyBrandedOverlay(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0);

  const barHeight = Math.round(source.height * 0.12);
  const gradient = ctx.createLinearGradient(0, canvas.height - barHeight, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.78)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);

  ctx.fillStyle = '#39ff88';
  ctx.fillRect(0, canvas.height - barHeight, canvas.width, Math.max(3, Math.round(source.height * 0.006)));

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(barHeight * 0.4)}px "Courier New", monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('g33kVault', canvas.width * 0.03, canvas.height - barHeight / 2);
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

async function uploadFile(file: File): Promise<boolean> {
  const formData = new FormData();
  formData.append('file', file);
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function startCamera(nextFacingMode: FacingMode) {
    stopCamera();
    setCameraReady(false);
    setCameraError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacingMode } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch {
      setCameraError('Could not access the camera. Check permissions and try again.');
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

    const shots = mode === 'burst' ? BURST_SHOTS : 1;
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < shots; i++) {
      if (!videoRef.current) break;
      triggerFlash();
      let canvas = grabFrame(videoRef.current, facingMode);
      if (mode === 'frame') canvas = applyFrame(canvas);
      if (mode === 'branded') canvas = applyBrandedOverlay(canvas);
      canvases.push(canvas);
      if (i < shots - 1) await wait(BURST_GAP_MS);
    }

    setPhase('uploading');
    const files = await Promise.all(
      canvases.map((c, i) => canvasToFile(c, `booth-${Date.now()}-${i}.jpg`))
    );
    const thumbs = canvases.map((c) => c.toDataURL('image/jpeg', 0.6));
    const results = await Promise.all(files.map(uploadFile));

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
        g33k<span>Vault</span> booth
      </h1>

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

        {phase === 'capturing' && mode === 'burst' && <div className="booth-status">📸 Burst!</div>}
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
