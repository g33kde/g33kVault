import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface MediaItem {
  id: string;
  filename: string;
  kind: 'image' | 'video';
  original_name: string | null;
  size: number;
  uploader?: string | null;
  photo_taken_at?: number | null;
  width?: number;
  height?: number;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type TransitionStyle = 'none' | 'fade' | 'zoom' | 'polaroid' | 'glitch' | 'arcade' | 'vhs' | 'random';

interface LastBackup {
  lastBackupAt: number;
  lastBackupSizeBytes: number;
  lastBackupItemCount: number;
}

interface DuplicateGroups {
  exact: MediaItem[][];
  similar: MediaItem[][];
}

interface PendingBatch {
  batchId: string;
  batchLabel: string;
  uploader: string | null;
  createdAt: number;
  items: MediaItem[];
}

interface SettingsPayload {
  slideshowIntervalMs: number;
  shuffle: boolean;
  transitionStyle: TransitionStyle;
  partyMode: boolean;
  slideshowEnabled: boolean;
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

// Plain Math.round rounds down to a literal "0%" for a while on any gallery
// bigger than ~200 items (item 1 of 1000 is 0.1%) — accurate, but reads as
// "stuck" rather than "just started". Once real progress exists (current >
// 0), floor the display at 1% so it never looks frozen.
function formatScanPercent(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.round((current / total) * 100));
}

// Mirrors the server's planDuplicateDeletions clustering (duplicateDetect.ts)
// closely enough to show an accurate count in the confirm dialog: a photo
// can appear in more than one group (an exact-duplicate trio is also a
// similar-photos cluster), so counting group sizes directly would double-
// count it. Union-find merges overlapping groups into clusters first, then
// each cluster of size N contributes N-1 deletions (one survivor kept).
function countDuplicatesToDelete(groups: DuplicateGroups): number {
  const parent = new Map<string, string>();
  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = id;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const allGroups = [...groups.exact, ...groups.similar];
  for (const group of allGroups) {
    for (const item of group) {
      if (!parent.has(item.id)) parent.set(item.id, item.id);
    }
    for (let i = 1; i < group.length; i++) {
      union(group[0].id, group[i].id);
    }
  }

  const clusterSizes = new Map<string, number>();
  for (const id of parent.keys()) {
    const root = find(id);
    clusterSizes.set(root, (clusterSizes.get(root) ?? 0) + 1);
  }

  let total = 0;
  for (const size of clusterSizes.values()) {
    if (size > 1) total += size - 1;
  }
  return total;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={open ? '#39ff88' : '#7f9c8a'}
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="admin-tool-chevron"
      style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
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

// "Custom" isn't in this map — its width/height come from the free-text
// inputs instead of a fixed value.
const LOW_RES_PRESETS = {
  tiny: { width: 160, height: 120, label: 'Tiny thumbnails (160×120)' },
  vga: { width: 640, height: 480, label: 'Old VGA (640×480)' },
  sd: { width: 854, height: 480, label: 'SD (854×480)' },
  hd: { width: 1280, height: 720, label: 'HD-ready (1280×720)' },
} as const;
type LowResPreset = keyof typeof LOW_RES_PRESETS | 'custom';

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
  const [slideshowEnabled, setSlideshowEnabled] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState('');

  const [lastBackup, setLastBackupState] = useState<LastBackup | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [backupError, setBackupError] = useState('');

  const [duplicates, setDuplicates] = useState<DuplicateGroups | null>(null);
  const [scanningDuplicates, setScanningDuplicates] = useState(false);
  const [duplicatesError, setDuplicatesError] = useState('');
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null);
  const [deletingAllDuplicates, setDeletingAllDuplicates] = useState(false);
  const [deleteAllProgress, setDeleteAllProgress] = useState<{ current: number; total: number } | null>(null);
  const [deleteAllError, setDeleteAllError] = useState('');

  const [scanningPhotoDates, setScanningPhotoDates] = useState(false);
  const [photoDatesProgress, setPhotoDatesProgress] = useState<{ current: number; total: number } | null>(null);
  const [photoDatesError, setPhotoDatesError] = useState('');
  const [photoDatesResult, setPhotoDatesResult] = useState<{ scanned: number; found: number } | null>(null);

  const [lowResItems, setLowResItems] = useState<MediaItem[] | null>(null);
  const [lowResThreshold, setLowResThreshold] = useState<{ width: number; height: number } | null>(null);
  const [scanningLowRes, setScanningLowRes] = useState(false);
  const [lowResError, setLowResError] = useState('');
  const [lowResProgress, setLowResProgress] = useState<{ current: number; total: number } | null>(null);
  const [deletingAllLowRes, setDeletingAllLowRes] = useState(false);
  const [deleteAllLowResProgress, setDeleteAllLowResProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [deleteAllLowResError, setDeleteAllLowResError] = useState('');

  // Defaults to Custom pre-filled at 320x280 rather than one of the named
  // presets — picking a preset re-fills these two fields, and switching
  // back to Custom keeps whatever was last typed.
  const [lowResPreset, setLowResPreset] = useState<LowResPreset>('custom');
  const [lowResCustomWidth, setLowResCustomWidth] = useState('320');
  const [lowResCustomHeight, setLowResCustomHeight] = useState('280');

  // Unlike the other tools, pending review isn't "occasional maintenance" —
  // a batch sitting unreviewed means it's not in the slideshow yet, which
  // matters during a live event — so this loads automatically rather than
  // waiting for an explicit scan click, and stays live via the
  // 'media:pending' broadcast.
  const [pendingBatches, setPendingBatches] = useState<PendingBatch[] | null>(null);
  const [pendingBatchesError, setPendingBatchesError] = useState('');
  const [approvingBatchId, setApprovingBatchId] = useState<string | null>(null);
  const [rejectingBatchId, setRejectingBatchId] = useState<string | null>(null);
  const [batchActionError, setBatchActionError] = useState('');

  // The occasional-use maintenance tools collapse into accordion rows (see
  // CHANGELOG) — collapsed by default so the page opens short; each stays
  // independently toggleable rather than closing the others.
  const [backupOpen, setBackupOpen] = useState(false);
  const [duplicatesToolOpen, setDuplicatesToolOpen] = useState(false);
  const [photoDatesToolOpen, setPhotoDatesToolOpen] = useState(false);
  const [lowResToolOpen, setLowResToolOpen] = useState(false);
  const [pendingUploadsOpen, setPendingUploadsOpen] = useState(false);

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
        setSlideshowEnabled(data.slideshowEnabled);
        setLastBackupState(data.lastBackup);
      })
      .catch((status) => {
        if (status === 401) handleAuthFailure();
      });

    fetchPendingBatches();

    const socket: Socket = io({ path: '/socket.io' });
    socket.on('media:new', (item: MediaItem) => setItems((prev) => [...prev, item]));
    // A batch just got approved — reflect it in the Photo Gallery grid the
    // same way a fresh upload would, since /api/media (fetched once above)
    // won't otherwise pick it up until the page is reloaded.
    socket.on('media:approved', (item: MediaItem) => setItems((prev) => [...prev, item]));
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
      setSlideshowEnabled(data.slideshowEnabled);
      setLastBackupState(data.lastBackup);
    });
    socket.on('duplicates:progress', (data: { current: number; total: number }) => setScanProgress(data));
    socket.on('duplicates:deleteProgress', (data: { current: number; total: number }) => setDeleteAllProgress(data));
    socket.on('photoDates:progress', (data: { current: number; total: number }) => setPhotoDatesProgress(data));
    socket.on('lowRes:progress', (data: { current: number; total: number }) => setLowResProgress(data));
    socket.on('lowRes:deleteProgress', (data: { current: number; total: number }) => setDeleteAllLowResProgress(data));
    // A guest's archive upload finished background-processing — refresh the
    // pending list so a new batch (or new items in one already loading)
    // shows up without the admin needing to do anything.
    socket.on('media:pending', () => fetchPendingBatches());

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
          slideshowEnabled,
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

  // Shared by the single-item delete button and the bulk "delete all
  // duplicates" action below. Returns whether the delete actually succeeded
  // so callers can distinguish it from a 401 (session expiry already
  // handled centrally via handleAuthFailure) or a genuine failure.
  async function deleteMediaItem(id: string): Promise<boolean> {
    if (!password) return false;
    const res = await fetch(`/api/media/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Password': password },
    });

    if (res.status === 401) {
      handleAuthFailure();
      return false;
    }

    if (res.ok) {
      setItems((prev) => prev.filter((i) => i.id !== id));
      // Also drop it from any duplicate-group results already on screen,
      // removing a group entirely once it's down to one item — a "group"
      // of one isn't a duplicate anymore.
      setDuplicates((prev) => {
        if (!prev) return prev;
        const strip = (groups: MediaItem[][]) =>
          groups.map((g) => g.filter((i) => i.id !== id)).filter((g) => g.length > 1);
        return { exact: strip(prev.exact), similar: strip(prev.similar) };
      });
      // Same idea for the low-resolution list already on screen.
      setLowResItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
      return true;
    }
    return false;
  }

  async function handleDelete(id: string) {
    if (!password) return;
    if (!window.confirm('Delete this photo/video? This cannot be undone.')) return;

    setDeletingId(id);
    try {
      await deleteMediaItem(id);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleDeleteAllDuplicates() {
    if (!password || !duplicates) return;

    // Just for the confirmation prompt — mirrors the server's own
    // clustering (planDuplicateDeletions) so the count shown here matches
    // what actually gets deleted; the server recomputes the authoritative
    // plan itself rather than trusting anything from this estimate.
    const count = countDuplicatesToDelete(duplicates);
    if (count === 0) return;

    if (
      !window.confirm(
        `Delete ${count} duplicate photo${count === 1 ? '' : 's'}? One copy of each will be kept. This cannot be undone.`
      )
    ) {
      return;
    }

    setDeletingAllDuplicates(true);
    setDeleteAllError('');
    setDeleteAllProgress(null);
    try {
      const res = await fetch('/api/admin/duplicates/delete-all', {
        method: 'POST',
        headers: { 'X-Admin-Password': password },
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteAllError(data.error || 'Delete failed');
        return;
      }

      // The batch fully cleaned things up server-side; individual removals
      // arrive via the existing 'media:deleted' broadcast (already wired up
      // above) to update the gallery grid live.
      setDuplicates({ exact: [], similar: [] });
    } catch {
      setDeleteAllError('Network error');
    } finally {
      setDeletingAllDuplicates(false);
      setDeleteAllProgress(null);
    }
  }

  async function handleScanDuplicates() {
    if (!password) return;

    setScanningDuplicates(true);
    setDuplicatesError('');
    setScanProgress(null);
    try {
      const res = await fetch('/api/admin/duplicates', { headers: { 'X-Admin-Password': password } });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDuplicatesError(data.error || 'Scan failed');
        return;
      }

      setDuplicates(await res.json());
    } catch {
      setDuplicatesError('Network error');
    } finally {
      setScanningDuplicates(false);
      setScanProgress(null);
    }
  }

  async function handleScanPhotoDates() {
    if (!password) return;

    setScanningPhotoDates(true);
    setPhotoDatesError('');
    setPhotoDatesProgress(null);
    setPhotoDatesResult(null);
    try {
      const res = await fetch('/api/admin/photo-dates/scan', {
        method: 'POST',
        headers: { 'X-Admin-Password': password },
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPhotoDatesError(data.error || 'Scan failed');
        return;
      }

      // Individual results arrive live via 'media:updated' (already wired up
      // above); this is just the summary for the button area.
      setPhotoDatesResult(await res.json());
    } catch {
      setPhotoDatesError('Network error');
    } finally {
      setScanningPhotoDates(false);
      setPhotoDatesProgress(null);
    }
  }

  // null means the custom fields don't hold a valid pair of positive
  // numbers yet — callers treat that as "can't scan right now" rather than
  // falling back to some default the admin didn't choose.
  function getActiveLowResThreshold(): { width: number; height: number } | null {
    if (lowResPreset !== 'custom') return LOW_RES_PRESETS[lowResPreset];
    const width = Number(lowResCustomWidth);
    const height = Number(lowResCustomHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  }

  async function handleScanLowRes() {
    if (!password) return;
    const threshold = getActiveLowResThreshold();
    if (!threshold) {
      setLowResError('Enter a valid width and height');
      return;
    }

    setScanningLowRes(true);
    setLowResError('');
    setLowResProgress(null);
    try {
      const res = await fetch(`/api/admin/low-resolution?maxWidth=${threshold.width}&maxHeight=${threshold.height}`, {
        headers: { 'X-Admin-Password': password },
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLowResError(data.error || 'Scan failed');
        return;
      }

      const data: { items: MediaItem[] } = await res.json();
      setLowResItems(data.items);
      setLowResThreshold(threshold);
    } catch {
      setLowResError('Network error');
    } finally {
      setScanningLowRes(false);
      setLowResProgress(null);
    }
  }

  async function handleDeleteAllLowRes() {
    if (!password || !lowResItems || lowResItems.length === 0 || !lowResThreshold) return;

    if (
      !window.confirm(
        `Delete ${lowResItems.length} low-resolution photo${lowResItems.length === 1 ? '' : 's'}? This cannot be undone.`
      )
    ) {
      return;
    }

    setDeletingAllLowRes(true);
    setDeleteAllLowResError('');
    setDeleteAllLowResProgress(null);
    try {
      const res = await fetch(
        `/api/admin/low-resolution/delete-all?maxWidth=${lowResThreshold.width}&maxHeight=${lowResThreshold.height}`,
        {
          method: 'POST',
          headers: { 'X-Admin-Password': password },
        }
      );

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteAllLowResError(data.error || 'Delete failed');
        return;
      }

      // Individual removals arrive via the existing 'media:deleted'
      // broadcast (already wired up above) to update the gallery grid live.
      setLowResItems([]);
    } catch {
      setDeleteAllLowResError('Network error');
    } finally {
      setDeletingAllLowRes(false);
      setDeleteAllLowResProgress(null);
    }
  }

  async function fetchPendingBatches() {
    if (!password) return;
    try {
      const res = await fetch('/api/admin/pending-batches', { headers: { 'X-Admin-Password': password } });
      if (res.status === 401) {
        handleAuthFailure();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPendingBatchesError(data.error || 'Could not load pending uploads');
        return;
      }
      setPendingBatches(await res.json());
      setPendingBatchesError('');
    } catch {
      setPendingBatchesError('Network error');
    }
  }

  async function handleApproveBatch(batch: PendingBatch) {
    if (!password) return;
    if (
      !window.confirm(
        `Approve ${batch.items.length} photo${batch.items.length === 1 ? '' : 's'} from "${
          batch.batchLabel
        }"? They'll start appearing in the slideshow.`
      )
    ) {
      return;
    }

    setApprovingBatchId(batch.batchId);
    setBatchActionError('');
    try {
      const res = await fetch(`/api/admin/pending-batches/${batch.batchId}/approve`, {
        method: 'POST',
        headers: { 'X-Admin-Password': password },
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setBatchActionError(data.error || 'Approve failed');
        return;
      }

      setPendingBatches((prev) => (prev ? prev.filter((b) => b.batchId !== batch.batchId) : prev));
    } catch {
      setBatchActionError('Network error');
    } finally {
      setApprovingBatchId(null);
    }
  }

  async function handleRejectBatch(batch: PendingBatch) {
    if (!password) return;
    if (
      !window.confirm(
        `Reject and permanently delete ${batch.items.length} photo${
          batch.items.length === 1 ? '' : 's'
        } from "${batch.batchLabel}"? This cannot be undone.`
      )
    ) {
      return;
    }

    setRejectingBatchId(batch.batchId);
    setBatchActionError('');
    try {
      const res = await fetch(`/api/admin/pending-batches/${batch.batchId}/reject`, {
        method: 'POST',
        headers: { 'X-Admin-Password': password },
      });

      if (res.status === 401) {
        handleAuthFailure();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setBatchActionError(data.error || 'Reject failed');
        return;
      }

      setPendingBatches((prev) => (prev ? prev.filter((b) => b.batchId !== batch.batchId) : prev));
    } catch {
      setBatchActionError('Network error');
    } finally {
      setRejectingBatchId(null);
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

  function backupSummary(): string {
    if (!lastBackup) return 'No backup taken yet';
    return `Last backup ${formatRelativeTime(lastBackup.lastBackupAt)} · ${formatBackupSize(
      lastBackup.lastBackupSizeBytes
    )} · ${lastBackup.lastBackupItemCount} item${lastBackup.lastBackupItemCount === 1 ? '' : 's'}`;
  }

  function duplicatesSummary(): string {
    if (!duplicates) return 'Not scanned yet';
    if (duplicates.exact.length === 0 && duplicates.similar.length === 0) return 'No duplicates found';
    const parts: string[] = [];
    if (duplicates.exact.length > 0) parts.push(`${duplicates.exact.length} exact`);
    if (duplicates.similar.length > 0) parts.push(`${duplicates.similar.length} similar`);
    return parts.join(' · ');
  }

  function photoDatesSummary(): string {
    if (!photoDatesResult) return 'Not scanned yet';
    return `Found dates for ${photoDatesResult.found}/${photoDatesResult.scanned} photos`;
  }

  function lowResSummary(): string {
    if (!lowResItems || !lowResThreshold) return 'Not scanned yet';
    if (lowResItems.length === 0) return `No photos at or below ${lowResThreshold.width}×${lowResThreshold.height}`;
    return `${lowResItems.length} photo${lowResItems.length === 1 ? '' : 's'} at or below ${lowResThreshold.width}×${
      lowResThreshold.height
    }`;
  }

  function pendingSummary(): string {
    if (!pendingBatches) return 'Loading…';
    if (pendingBatches.length === 0) return 'Nothing pending';
    const totalPhotos = pendingBatches.reduce((sum, b) => sum + b.items.length, 0);
    return `${pendingBatches.length} batch${pendingBatches.length === 1 ? '' : 'es'}, ${totalPhotos} photo${
      totalPhotos === 1 ? '' : 's'
    } awaiting review`;
  }

  // A fixed window name (rather than a new one per click) means clicking a
  // different photo while a viewer window is already open navigates that
  // same window instead of spawning another one. Explicit size/chrome flags
  // are the standard way to ask for a separate window rather than a tab —
  // browsers treat this as a preference, not a guarantee.
  function openPhotoViewer(id: string) {
    window.open(
      `/photo-viewer?id=${encodeURIComponent(id)}`,
      'g33kvault-photo-viewer',
      'width=1100,height=850,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes,popup=1'
    );
  }

  function renderDuplicateGroups(groups: MediaItem[][]) {
    return groups.map((group) => (
      <div key={group.map((i) => i.id).join(',')} className="duplicate-group">
        {group.map((item) => (
          <div key={item.id} className="admin-thumb duplicate-thumb">
            {item.kind === 'video' ? (
              <video src={`/media/${item.filename}`} controls muted playsInline />
            ) : (
              <img src={`/media/${item.filename}?v=${item.size}`} alt="" />
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
    ));
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

      <div className="admin-card">
        <h2 className="admin-card-heading">Playback Settings</h2>
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

          <label htmlFor="slideshow-enabled-input" className="admin-checkbox-label">
            <input
              id="slideshow-enabled-input"
              type="checkbox"
              checked={slideshowEnabled}
              onChange={(e) => {
                setSlideshowEnabled(e.target.checked);
                setSaveStatus('idle');
              }}
            />
            Enable Slideshow
          </label>

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
      </div>

      <div className="admin-tools">
        <h2 className="admin-tools-label">Gallery Tools</h2>

        <div className={`admin-tool ${pendingUploadsOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="admin-tool-header"
            onClick={() => setPendingUploadsOpen((o) => !o)}
          >
            <span>📦 Pending Uploads</span>
            <span className="admin-tool-header-right">
              <span className="admin-tool-summary">{pendingSummary()}</span>
              <Chevron open={pendingUploadsOpen} />
            </span>
          </button>
          {pendingUploadsOpen && (
            <div className="admin-tool-body">
              {pendingBatchesError && <p className="error-msg">{pendingBatchesError}</p>}
              {batchActionError && <p className="error-msg">{batchActionError}</p>}
              {pendingBatches && pendingBatches.length === 0 && (
                <p className="tagline">No archive uploads awaiting review.</p>
              )}
              {pendingBatches && pendingBatches.length > 0 && (
                <div className="pending-batches">
                  {pendingBatches.map((batch) => (
                    <div key={batch.batchId} className="pending-batch">
                      <div className="pending-batch-header">
                        <div className="pending-batch-info">
                          <span className="pending-batch-label">{batch.batchLabel}</span>
                          <span className="tagline">
                            {batch.items.length} photo{batch.items.length === 1 ? '' : 's'}
                            {batch.uploader ? ` · from ${batch.uploader}` : ''} ·{' '}
                            {formatRelativeTime(batch.createdAt)}
                          </span>
                        </div>
                        <div className="pending-batch-actions">
                          <button
                            className="btn btn-primary"
                            onClick={() => handleApproveBatch(batch)}
                            disabled={approvingBatchId === batch.batchId || rejectingBatchId === batch.batchId}
                          >
                            {approvingBatchId === batch.batchId
                              ? 'Approving…'
                              : `✅ Approve All (${batch.items.length})`}
                          </button>
                          <button
                            className="btn btn-danger"
                            onClick={() => handleRejectBatch(batch)}
                            disabled={approvingBatchId === batch.batchId || rejectingBatchId === batch.batchId}
                          >
                            {rejectingBatchId === batch.batchId
                              ? 'Rejecting…'
                              : `🗑 Reject All (${batch.items.length})`}
                          </button>
                        </div>
                      </div>
                      <div className="admin-grid">
                        {batch.items.map((item) => (
                          <div key={item.id} className="admin-thumb">
                            {item.kind === 'video' ? (
                              <video src={`/media/${item.filename}`} controls muted playsInline />
                            ) : (
                              <img src={`/media/${item.filename}?v=${item.size}`} alt="" />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className={`admin-tool ${backupOpen ? 'open' : ''}`}>
          <button type="button" className="admin-tool-header" onClick={() => setBackupOpen((o) => !o)}>
            <span>⬇ Backup &amp; Restore</span>
            <span className="admin-tool-header-right">
              <span
                className={`admin-tool-summary ${
                  lastBackup && Date.now() - lastBackup.lastBackupAt > STALE_BACKUP_MS ? 'backup-status stale' : ''
                }`}
              >
                {backupSummary()}
              </span>
              <Chevron open={backupOpen} />
            </span>
          </button>
          {backupOpen && (
            <div className="admin-tool-body">
              <div className="admin-backup">
                <button className="btn btn-primary" onClick={handleBackup} disabled={backingUp}>
                  {backingUp ? 'Preparing backup…' : '⬇ Download Backup'}
                </button>
              </div>
              {backupError && <p className="error-msg">{backupError}</p>}
            </div>
          )}
        </div>

        <div className={`admin-tool ${duplicatesToolOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="admin-tool-header"
            onClick={() => setDuplicatesToolOpen((o) => !o)}
          >
            <span>🔍 Duplicate Photos</span>
            <span className="admin-tool-header-right">
              <span className="admin-tool-summary">{duplicatesSummary()}</span>
              <Chevron open={duplicatesToolOpen} />
            </span>
          </button>
          {duplicatesToolOpen && (
            <div className="admin-tool-body">
              <div className="admin-duplicates">
                <button className="btn btn-primary" onClick={handleScanDuplicates} disabled={scanningDuplicates}>
                  {scanningDuplicates
                    ? scanProgress && scanProgress.total > 0
                      ? `Scanning… ${formatScanPercent(scanProgress.current, scanProgress.total)}%`
                      : 'Scanning…'
                    : '🔍 Scan for Duplicates'}
                </button>
                {duplicatesError && <p className="error-msg">{duplicatesError}</p>}

                {duplicates && (
                  <div className="duplicates-results">
                    {duplicates.exact.length === 0 && duplicates.similar.length === 0 ? (
                      <p className="tagline">No duplicates found.</p>
                    ) : (
                      <>
                        <button
                          className="btn btn-danger admin-delete-all-duplicates-btn"
                          onClick={handleDeleteAllDuplicates}
                          disabled={deletingAllDuplicates}
                        >
                          {deletingAllDuplicates
                            ? deleteAllProgress && deleteAllProgress.total > 0
                              ? `Deleting… ${formatScanPercent(deleteAllProgress.current, deleteAllProgress.total)}%`
                              : 'Deleting…'
                            : '🗑 Delete All Duplicates (keep one of each)'}
                        </button>
                        {deleteAllError && <p className="error-msg">{deleteAllError}</p>}
                        {duplicates.exact.length > 0 && (
                          <>
                            <p className="tagline duplicates-heading">
                              Exact duplicates — {duplicates.exact.length} group
                              {duplicates.exact.length === 1 ? '' : 's'}
                            </p>
                            {renderDuplicateGroups(duplicates.exact)}
                          </>
                        )}
                        {duplicates.similar.length > 0 && (
                          <>
                            <p className="tagline duplicates-heading">
                              Similar photos — {duplicates.similar.length} group
                              {duplicates.similar.length === 1 ? '' : 's'}
                            </p>
                            {renderDuplicateGroups(duplicates.similar)}
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className={`admin-tool ${photoDatesToolOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="admin-tool-header"
            onClick={() => setPhotoDatesToolOpen((o) => !o)}
          >
            <span>📅 Photo Dates</span>
            <span className="admin-tool-header-right">
              <span className="admin-tool-summary">{photoDatesSummary()}</span>
              <Chevron open={photoDatesToolOpen} />
            </span>
          </button>
          {photoDatesToolOpen && (
            <div className="admin-tool-body">
              <div className="admin-photo-dates">
                <button className="btn btn-primary" onClick={handleScanPhotoDates} disabled={scanningPhotoDates}>
                  {scanningPhotoDates
                    ? photoDatesProgress && photoDatesProgress.total > 0
                      ? `Scanning… ${formatScanPercent(photoDatesProgress.current, photoDatesProgress.total)}%`
                      : 'Scanning…'
                    : '📅 Scan Photo Dates'}
                </button>
                {photoDatesError && <p className="error-msg">{photoDatesError}</p>}
                {photoDatesResult && (
                  <p className="tagline">
                    Found a date for {photoDatesResult.found} of {photoDatesResult.scanned} photo
                    {photoDatesResult.scanned === 1 ? '' : 's'} — shown as an overlay during the slideshow. Photos
                    with no EXIF date (screenshots, booth captures, or older HEIC imports that already lost their
                    metadata) won't show one.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className={`admin-tool ${lowResToolOpen ? 'open' : ''}`}>
          <button type="button" className="admin-tool-header" onClick={() => setLowResToolOpen((o) => !o)}>
            <span>🖼 Low-Resolution Photos</span>
            <span className="admin-tool-header-right">
              <span className="admin-tool-summary">{lowResSummary()}</span>
              <Chevron open={lowResToolOpen} />
            </span>
          </button>
          {lowResToolOpen && (
            <div className="admin-tool-body">
              <div className="admin-duplicates">
                <div className="admin-settings">
                  <label htmlFor="lowres-preset-input">Resolution threshold</label>
                  <select
                    id="lowres-preset-input"
                    value={lowResPreset}
                    onChange={(e) => {
                      setLowResPreset(e.target.value as LowResPreset);
                      setLowResItems(null);
                      setLowResThreshold(null);
                      setLowResError('');
                    }}
                  >
                    {(Object.keys(LOW_RES_PRESETS) as (keyof typeof LOW_RES_PRESETS)[]).map((key) => (
                      <option key={key} value={key}>
                        {LOW_RES_PRESETS[key].label}
                      </option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                  {lowResPreset === 'custom' && (
                    <>
                      <input
                        type="number"
                        min={1}
                        value={lowResCustomWidth}
                        onChange={(e) => {
                          setLowResCustomWidth(e.target.value);
                          setLowResItems(null);
                          setLowResThreshold(null);
                          setLowResError('');
                        }}
                        aria-label="Width"
                      />
                      <span>×</span>
                      <input
                        type="number"
                        min={1}
                        value={lowResCustomHeight}
                        onChange={(e) => {
                          setLowResCustomHeight(e.target.value);
                          setLowResItems(null);
                          setLowResThreshold(null);
                          setLowResError('');
                        }}
                        aria-label="Height"
                      />
                    </>
                  )}
                </div>

                <button className="btn btn-primary" onClick={handleScanLowRes} disabled={scanningLowRes}>
                  {scanningLowRes
                    ? lowResProgress && lowResProgress.total > 0
                      ? `Scanning… ${formatScanPercent(lowResProgress.current, lowResProgress.total)}%`
                      : 'Scanning…'
                    : '🖼 Scan for Low-Resolution Photos'}
                </button>
                {lowResError && <p className="error-msg">{lowResError}</p>}

                {lowResItems && (
                  <div className="duplicates-results">
                    {lowResItems.length === 0 ? (
                      <p className="tagline">{lowResSummary()}.</p>
                    ) : (
                      <>
                        <button
                          className="btn btn-danger admin-delete-all-duplicates-btn"
                          onClick={handleDeleteAllLowRes}
                          disabled={deletingAllLowRes}
                        >
                          {deletingAllLowRes
                            ? deleteAllLowResProgress && deleteAllLowResProgress.total > 0
                              ? `Deleting… ${formatScanPercent(
                                  deleteAllLowResProgress.current,
                                  deleteAllLowResProgress.total
                                )}%`
                              : 'Deleting…'
                            : `🗑 Delete All Low-Resolution Photos (${lowResItems.length})`}
                        </button>
                        {deleteAllLowResError && <p className="error-msg">{deleteAllLowResError}</p>}
                        <div className="admin-grid">
                          {lowResItems.map((item) => (
                            <div key={item.id} className="admin-thumb">
                              <a href={`/media/${item.filename}?v=${item.size}`} target="_blank" rel="noopener noreferrer">
                                <img src={`/media/${item.filename}?v=${item.size}`} alt="" />
                              </a>
                              {item.width && item.height && (
                                <span className="admin-thumb-resolution">
                                  {item.width}×{item.height}
                                </span>
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
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="admin-card">
        <h2 className="admin-card-heading">Photo Gallery</h2>
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
                  <button type="button" className="admin-thumb-open-btn" onClick={() => openPhotoViewer(item.id)}>
                    <img src={`/media/${item.filename}?v=${item.size}`} alt="" />
                  </button>
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
    </div>
  );
}
