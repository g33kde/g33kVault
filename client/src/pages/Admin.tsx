import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface MediaItem {
  id: string;
  filename: string;
  kind: 'image' | 'video';
  original_name: string | null;
  size: number;
  uploader?: string | null;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type TransitionStyle = 'none' | 'fade' | 'zoom' | 'polaroid' | 'glitch' | 'arcade' | 'vhs' | 'random';

interface LastBackup {
  lastBackupAt: number;
  lastBackupSizeBytes: number;
  lastBackupItemCount: number;
}

interface SettingsPayload {
  slideshowIntervalMs: number;
  shuffle: boolean;
  transitionStyle: TransitionStyle;
  partyMode: boolean;
  lastBackup: LastBackup | null;
}

const STORAGE_KEY = 'g33kvault-admin-password';
const MIN_SECONDS = 1;
const MAX_SECONDS = 600;
const STALE_BACKUP_MS = 7 * 24 * 60 * 60 * 1000;

function formatBackupSize(bytes: number): string {
  return bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

function formatRelativeTime(ms: number): string {
  const diffMinutes = Math.floor((Date.now() - ms) / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

const TRANSITION_LABELS: Record<TransitionStyle, string> = {
  none: 'None (instant cut)',
  fade: 'Smooth fade',
  zoom: 'Zoom',
  polaroid: 'Polaroid drop',
  glitch: 'Glitch',
  arcade: 'Arcade / game-style',
  vhs: 'VHS',
  random: 'Random',
};

export default function Admin() {
  const [password, setPassword] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState('');

  const [intervalSeconds, setIntervalSeconds] = useState('');
  const [shuffle, setShuffle] = useState(false);
  const [transitionStyle, setTransitionStyle] = useState<TransitionStyle>('none');
  const [partyMode, setPartyMode] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState('');

  const [lastBackup, setLastBackupState] = useState<LastBackup | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [backupError, setBackupError] = useState('');

  async function verifyPassword(candidate: string) {
    if (!candidate) return;
    setVerifying(true);
    setAuthError('');
    try {
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'X-Admin-Password': candidate },
      });
      if (res.ok) {
        sessionStorage.setItem(STORAGE_KEY, candidate);
        setPassword(candidate);
      } else {
        setAuthError('Wrong password');
      }
    } catch {
      setAuthError('Network error');
    } finally {
      setVerifying(false);
    }
  }

  function handleAuthFailure() {
    sessionStorage.removeItem(STORAGE_KEY);
    setPassword(null);
    setAuthError('Session expired — enter the password again');
  }

  useEffect(() => {
    if (!password) return undefined;

    fetch('/api/media')
      .then((r) => r.json())
      .then(setItems);

    fetch('/api/admin/settings', { headers: { 'X-Admin-Password': password } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: SettingsPayload) => {
        setIntervalSeconds(String(data.slideshowIntervalMs / 1000));
        setShuffle(data.shuffle);
        setTransitionStyle(data.transitionStyle);
        setPartyMode(data.partyMode);
        setLastBackupState(data.lastBackup);
      })
      .catch((status) => {
        if (status === 401) handleAuthFailure();
      });

    const socket: Socket = io({ path: '/socket.io' });
    socket.on('media:new', (item: MediaItem) => setItems((prev) => [...prev, item]));
    socket.on('media:deleted', ({ id }: { id: string }) =>
      setItems((prev) => prev.filter((i) => i.id !== id))
    );
    socket.on('media:updated', (updated: MediaItem) =>
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    );
    socket.on('config:updated', (data: SettingsPayload) => {
      setIntervalSeconds(String(data.slideshowIntervalMs / 1000));
      setShuffle(data.shuffle);
      setTransitionStyle(data.transitionStyle);
      setPartyMode(data.partyMode);
      setLastBackupState(data.lastBackup);
    });

    return () => {
      socket.disconnect();
    };
  }, [password]);

  async function handleSaveInterval(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;

    const seconds = Number(intervalSeconds);
    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
      setSaveStatus('error');
      setSaveError(`Enter a number between ${MIN_SECONDS} and ${MAX_SECONDS} seconds`);
      return;
    }

    setSaveStatus('saving');
    setSaveError('');
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
        body: JSON.stringify({
          slideshowIntervalMs: Math.round(seconds * 1000),
          shuffle,
          transitionStyle,
          partyMode,
        }),
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveStatus('error');
        setSaveError(data.error || 'Could not save');
        return;
      }

      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
      setSaveError('Network error');
    }
  }

  async function handleBackup() {
    if (!password) return;

    setBackingUp(true);
    setBackupError('');
    try {
      const res = await fetch('/api/admin/backup', { headers: { 'X-Admin-Password': password } });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setBackupError(data.error || 'Backup failed');
        return;
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'g33kvault-backup.tar.gz';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // lastBackup status updates via the 'config:updated' broadcast the
      // server sends once the backup completes server-side.
    } catch {
      setBackupError('Network error');
    } finally {
      setBackingUp(false);
    }
  }

  async function handleDelete(id: string) {
    if (!password) return;
    if (!window.confirm('Delete this photo/video? This cannot be undone.')) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/media/${id}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Password': password },
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== id));
      }
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRotate(id: string, direction: 'cw' | 'ccw') {
    if (!password) return;

    setRotatingId(id);
    setRotateError('');
    try {
      const res = await fetch(`/api/media/${id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
        body: JSON.stringify({ direction }),
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRotateError(data.error || 'Could not rotate this image');
        return;
      }

      const updated: MediaItem = await res.json();
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch {
      setRotateError('Network error');
    } finally {
      setRotatingId(null);
    }
  }

  if (!password) {
    return (
      <div className="page admin-page">
        <h1 className="brand">
          <a href="/" className="brand-link">
            g33k<span>Vault</span>
          </a>
        </h1>
        <p className="tagline">Admin</p>
        <form
          className="admin-login"
          onSubmit={(e) => {
            e.preventDefault();
            verifyPassword(passwordInput);
          }}
        >
          <input
            type="password"
            placeholder="Admin password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={verifying || !passwordInput}>
            {verifying ? 'Checking…' : 'Unlock'}
          </button>
        </form>
        {authError && <p className="error-msg">{authError}</p>}
      </div>
    );
  }

  return (
    <div className="page admin-page">
      <h1 className="brand">
        <a href="/" className="brand-link">
          g33k<span>Vault</span> admin
        </a>
      </h1>

      <form
        className="admin-settings"
        onSubmit={(e) => {
          handleSaveInterval(e);
        }}
      >
        <label htmlFor="interval-input">Slideshow speed</label>
        <input
          id="interval-input"
          type="number"
          min={MIN_SECONDS}
          max={MAX_SECONDS}
          step="0.5"
          value={intervalSeconds}
          onChange={(e) => {
            setIntervalSeconds(e.target.value);
            setSaveStatus('idle');
          }}
        />
        <span>seconds per photo</span>

        <label htmlFor="shuffle-input" className="admin-checkbox-label">
          <input
            id="shuffle-input"
            type="checkbox"
            checked={shuffle}
            onChange={(e) => {
              setShuffle(e.target.checked);
              setSaveStatus('idle');
            }}
          />
          Randomize playback order
        </label>

        <label htmlFor="transition-input">Transition</label>
        <select
          id="transition-input"
          value={transitionStyle}
          disabled={partyMode}
          onChange={(e) => {
            setTransitionStyle(e.target.value as TransitionStyle);
            setSaveStatus('idle');
          }}
        >
          {(Object.keys(TRANSITION_LABELS) as TransitionStyle[]).map((style) => (
            <option key={style} value={style}>
              {TRANSITION_LABELS[style]}
            </option>
          ))}
        </select>

        <label htmlFor="party-mode-input" className="admin-checkbox-label">
          <input
            id="party-mode-input"
            type="checkbox"
            checked={partyMode}
            onChange={(e) => {
              setPartyMode(e.target.checked);
              setSaveStatus('idle');
            }}
          />
          🎉 Party Mode (random transition every slide)
        </label>

        <button className="btn btn-primary" type="submit" disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {saveStatus === 'saved' && <span className="save-ok">Saved</span>}
      </form>
      {saveStatus === 'error' && <p className="error-msg">{saveError}</p>}

      <div className="admin-backup">
        <button className="btn btn-primary" onClick={handleBackup} disabled={backingUp}>
          {backingUp ? 'Preparing backup…' : '⬇ Download Backup'}
        </button>
        {lastBackup ? (
          <span className={`backup-status ${Date.now() - lastBackup.lastBackupAt > STALE_BACKUP_MS ? 'stale' : ''}`}>
            Last backup: {formatRelativeTime(lastBackup.lastBackupAt)} · {formatBackupSize(lastBackup.lastBackupSizeBytes)}{' '}
            · {lastBackup.lastBackupItemCount} item{lastBackup.lastBackupItemCount === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="backup-status stale">⚠ No backup taken yet</span>
        )}
      </div>
      {backupError && <p className="error-msg">{backupError}</p>}

      <p className="tagline">
        {items.length} item{items.length === 1 ? '' : 's'} — click ✕ to delete, ↺/↻ to rotate
      </p>
      {rotateError && <p className="error-msg">{rotateError}</p>}

      {items.length === 0 ? (
        <p>No photos yet.</p>
      ) : (
        <div className="admin-grid">
          {[...items].reverse().map((item) => (
            <div key={item.id} className="admin-thumb">
              {item.kind === 'video' ? (
                <video src={`/media/${item.filename}`} controls muted playsInline />
              ) : (
                <img src={`/media/${item.filename}?v=${item.size}`} alt="" />
              )}
              {item.uploader && (
                <span className="admin-thumb-uploader" title={item.uploader}>
                  {item.uploader}
                </span>
              )}
              {item.kind === 'image' && (
                <>
                  <button
                    className="admin-rotate-btn admin-rotate-ccw-btn"
                    onClick={() => handleRotate(item.id, 'ccw')}
                    disabled={rotatingId === item.id}
                    aria-label="Rotate counter-clockwise"
                    title="Rotate counter-clockwise"
                  >
                    {rotatingId === item.id ? '…' : '↺'}
                  </button>
                  <button
                    className="admin-rotate-btn admin-rotate-cw-btn"
                    onClick={() => handleRotate(item.id, 'cw')}
                    disabled={rotatingId === item.id}
                    aria-label="Rotate clockwise"
                    title="Rotate clockwise"
                  >
                    {rotatingId === item.id ? '…' : '↻'}
                  </button>
                </>
              )}
              <button
                className="admin-delete-btn"
                onClick={() => handleDelete(item.id)}
                disabled={deletingId === item.id}
                aria-label="Delete"
                title="Delete"
              >
                {deletingId === item.id ? '…' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
