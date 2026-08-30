import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Status = 'idle' | 'uploading' | 'done';

interface UploadResult {
  name: string;
  ok: boolean;
  error?: string;
  // True for an uploaded archive: it's been received and is being
  // extracted, but won't appear in the slideshow until an admin reviews
  // and approves it — a different outcome than a normal instant upload.
  pending?: boolean;
}

interface Stats {
  photos: number;
  videos: number;
  contributors: number;
  storageBytes: number;
  uptimeMs: number;
}

const THUMB_LIMIT = 12;
const STATS_TICK_MS = 30_000;
const UPLOADER_STORAGE_KEY = 'g33kvault-uploader-name';

function isArchiveFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.rar');
}

function formatStorage(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<UploadResult[]>([]);

  const [stats, setStats] = useState<Stats | null>(null);
  const [statsFetchedAt, setStatsFetchedAt] = useState(0);
  const [now, setNow] = useState(Date.now());

  const [uploaderName, setUploaderName] = useState(
    () => localStorage.getItem(UPLOADER_STORAGE_KEY) ?? ''
  );

  useEffect(() => {
    if (uploaderName) {
      localStorage.setItem(UPLOADER_STORAGE_KEY, uploaderName);
    } else {
      localStorage.removeItem(UPLOADER_STORAGE_KEY);
    }
  }, [uploaderName]);

  useEffect(() => {
    const toPreview = files.length === 1 ? files : files.slice(0, THUMB_LIMIT);
    const urls = toPreview.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [files]);

  function fetchStats() {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((data: Stats) => {
        setStats(data);
        setStatsFetchedAt(Date.now());
      });
  }

  useEffect(() => {
    fetchStats();

    const socket: Socket = io({ path: '/socket.io' });
    socket.on('media:new', fetchStats);
    socket.on('media:deleted', fetchStats);

    const tick = setInterval(() => setNow(Date.now()), STATS_TICK_MS);

    return () => {
      socket.disconnect();
      clearInterval(tick);
    };
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    setFiles(selected);
    setStatus('idle');
    setResults([]);
  }

  async function handleUpload() {
    if (files.length === 0) return;
    setStatus('uploading');
    setProgress(0);
    const outcomes: UploadResult[] = [];

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      if (uploaderName.trim()) {
        formData.append('uploader', uploaderName.trim());
      }
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (res.ok) {
          outcomes.push({ name: file.name, ok: true, pending: res.status === 202 });
        } else {
          const data = await res.json().catch(() => ({}));
          outcomes.push({ name: file.name, ok: false, error: data.error || 'Upload failed' });
        }
      } catch {
        outcomes.push({ name: file.name, ok: false, error: 'Network error' });
      }
      setProgress((p) => p + 1);
    }

    setResults(outcomes);
    setStatus('done');
    setFiles([]);
  }

  function reset() {
    setStatus('idle');
    setFiles([]);
    setResults([]);
    setProgress(0);
  }

  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok && !r.pending);
  const pendingArchives = results.filter((r) => r.ok && r.pending);

  return (
    <div className="page upload-page">
      <h1 className="brand">
        <a href="/" className="brand-link">
          g33k<span>Vault</span>
        </a>
      </h1>

      {status !== 'done' && (
        <input
          type="text"
          className="uploader-input"
          placeholder="Your name (optional)"
          maxLength={40}
          value={uploaderName}
          onChange={(e) => setUploaderName(e.target.value)}
        />
      )}

      {status === 'done' ? (
        <div className="success-panel">
          {succeeded.length > 0 && (
            <p>
              {succeeded.length} uploaded{failed.length > 0 ? `, ${failed.length} failed` : ''}.
            </p>
          )}
          {pendingArchives.length > 0 && (
            <p>
              📦 {pendingArchives.length} archive{pendingArchives.length === 1 ? '' : 's'} received and being
              processed — your photos will appear once the event host approves them.
            </p>
          )}
          {succeeded.length === 0 && pendingArchives.length === 0 && failed.length > 0 && (
            <p>{failed.length} failed.</p>
          )}
          {failed.length > 0 && (
            <ul className="fail-list">
              {failed.map((f) => (
                <li key={f.name}>
                  {f.name}: {f.error}
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-primary" onClick={reset}>
            Upload more
          </button>
        </div>
      ) : (
        <>
          {files.length === 0 && (
            <>
              <label className="file-picker">
                Choose photos or videos
                <input
                  type="file"
                  accept="image/*,video/*,.zip,.tar.gz,.rar"
                  multiple
                  onChange={handleFileChange}
                  hidden
                />
              </label>
              <p className="upload-archive-note">
                📦 Got a whole folder of photos? You can also upload a <strong>.zip</strong>, <strong>.tar.gz</strong>
                , or <strong>.rar</strong> file — they'll be reviewed by the event host before appearing in the
                slideshow.
              </p>
            </>
          )}

          {files.length === 1 &&
            status === 'idle' &&
            (isArchiveFile(files[0]) ? (
              <div className="preview archive-preview">📦 {files[0].name}</div>
            ) : files[0].type.startsWith('video') ? (
              <video src={previewUrls[0]} className="preview" controls />
            ) : (
              <img src={previewUrls[0]} className="preview" alt="preview" />
            ))}

          {files.length > 1 && status === 'idle' && (
            <div className="thumb-grid">
              {previewUrls.map((url, i) => (
                <div key={i} className="thumb">
                  {isArchiveFile(files[i]) ? (
                    <div className="archive-thumb">📦</div>
                  ) : files[i].type.startsWith('video') ? (
                    <video src={url} muted />
                  ) : (
                    <img src={url} alt="" />
                  )}
                </div>
              ))}
              {files.length > THUMB_LIMIT && (
                <div className="thumb thumb-more">+{files.length - THUMB_LIMIT}</div>
              )}
            </div>
          )}

          {files.length > 0 && status === 'idle' && (
            <div className="actions">
              <button className="btn btn-primary" onClick={handleUpload}>
                {files.length === 1 ? 'Upload' : `Upload all ${files.length}`}
              </button>
              <button className="btn btn-secondary" onClick={reset}>
                Cancel
              </button>
            </div>
          )}

          {status === 'uploading' && (
            <p>
              Uploading {progress} / {files.length}…
            </p>
          )}
        </>
      )}

      {stats && (
        <div className="stats-panel">
          <div className="stats-header">
            <span>EVENT STATISTICS</span>
            <span className="stats-live-dot" />
          </div>

          <div className="stats-row">
            <span className="stats-label">📸 Photos</span>
            <span className="stats-leader" />
            <span className="stats-value">{stats.photos}</span>
          </div>

          <div className="stats-row">
            <span className="stats-label">🎥 Videos</span>
            <span className="stats-leader" />
            <span className="stats-value">{stats.videos}</span>
          </div>

          <div className="stats-row">
            <span className="stats-label">👥 Contributors</span>
            <span className="stats-leader" />
            <span className="stats-value">{stats.contributors}</span>
          </div>

          <div className="stats-row">
            <span className="stats-label">💾 Storage</span>
            <span className="stats-leader" />
            <span className="stats-value">{formatStorage(stats.storageBytes)}</span>
          </div>

          <div className="stats-row">
            <span className="stats-label">⏱ Event runtime</span>
            <span className="stats-leader" />
            <span className="stats-value">{formatDuration(stats.uptimeMs + (now - statsFetchedAt))}</span>
          </div>
        </div>
      )}
    </div>
  );
}
