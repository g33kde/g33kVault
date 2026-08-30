import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface MediaItem {
  id: string;
  filename: string;
  mime_type: string;
  kind: 'image' | 'video';
  created_at: number;
  size: number;
  uploader?: string | null;
  photo_taken_at?: number | null;
}

type TransitionStyle = 'none' | 'fade' | 'zoom' | 'polaroid' | 'glitch' | 'arcade' | 'vhs' | 'random';

interface ConfigPayload {
  slideshowIntervalMs: number;
  shuffle: boolean;
  transitionStyle: TransitionStyle;
  partyMode: boolean;
  slideshowEnabled: boolean;
}

const DEFAULT_IMAGE_DURATION_MS = 6000;

// A freshly-uploaded image jumps the queue and plays immediately, overriding
// the normal per-image duration for this one slide — with a "New Upload"
// badge shown for the first part of that window.
const NEW_UPLOAD_DISPLAY_MS = 10000;
const NEW_UPLOAD_BADGE_MS = 5000;

// "random"/Party Mode pick from this pool — "none" is deliberately excluded
// since picking "no transition" at random would just look like a dropped frame.
const CONCRETE_TRANSITIONS: Exclude<TransitionStyle, 'none' | 'random'>[] = [
  'fade',
  'zoom',
  'polaroid',
  'glitch',
  'arcade',
  'vhs',
];

function formatPhotoDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickTransitionClass(style: TransitionStyle, partyMode: boolean): string {
  if (partyMode || style === 'random') {
    const pick = CONCRETE_TRANSITIONS[Math.floor(Math.random() * CONCRETE_TRANSITIONS.length)];
    return `t-${pick}`;
  }
  return style === 'none' ? '' : `t-${style}`;
}

export default function Slideshow() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [index, setIndex] = useState(0);
  const [imageDuration, setImageDuration] = useState(DEFAULT_IMAGE_DURATION_MS);
  const [shuffle, setShuffle] = useState(false);
  const [slideshowEnabled, setSlideshowEnabled] = useState(true);
  const [muted, setMuted] = useState(true);
  const [transitionClass, setTransitionClass] = useState('');
  const [showNewUploadBadge, setShowNewUploadBadge] = useState(false);
  const indexRef = useRef(0);
  const itemsRef = useRef<MediaItem[]>([]);
  const shuffleRef = useRef(false);
  const transitionStyleRef = useRef<TransitionStyle>('none');
  const partyModeRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const badgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // id of the item currently being shown as a "New Upload" — cleared once we
  // move past it, so it only ever highlights the one slide it belongs to.
  const highlightItemIdRef = useRef<string | null>(null);
  // Whether we're currently displaying a highlighted new upload — kept in
  // sync from the render effect below (derived from highlightItemIdRef vs.
  // the actual current item), not set ad hoc, so it can't drift out of sync
  // if the highlighted item gets deleted mid-highlight.
  const highlightActiveRef = useRef(false);
  // New images that arrive while a highlight is already playing wait here
  // instead of interrupting it, so back-to-back uploads each get their full
  // uninterrupted turn.
  const highlightQueueRef = useRef<MediaItem[]>([]);

  const current = items.length > 0 ? items[index % items.length] : null;

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);

  useEffect(() => {
    Promise.all([
      fetch('/api/media').then((r) => r.json()),
      fetch('/api/config').then((r) => r.json()),
    ]).then(([mediaData, configData]: [MediaItem[], ConfigPayload]) => {
      setImageDuration(configData.slideshowIntervalMs);
      setShuffle(configData.shuffle);
      shuffleRef.current = configData.shuffle;
      transitionStyleRef.current = configData.transitionStyle;
      partyModeRef.current = configData.partyMode;
      setSlideshowEnabled(configData.slideshowEnabled);
      setItems(configData.shuffle ? shuffleArray(mediaData) : mediaData);
    });

    const socket: Socket = io({ path: '/socket.io' });

    socket.on('media:new', (item: MediaItem) => {
      if (item.kind === 'image') {
        if (highlightActiveRef.current) {
          // A highlight is already playing — queue this one instead of
          // cutting it short, so back-to-back uploads don't interrupt each
          // other. Still gets added to the gallery right away; it just
          // waits its turn for the highlight treatment.
          highlightQueueRef.current.push(item);
          setItems((prev) => {
            const next = [...prev];
            const insertAt = Math.min(indexRef.current + 1, next.length);
            next.splice(insertAt, 0, item);
            return next;
          });
          return;
        }

        // No highlight active — interrupt whatever's currently showing and
        // jump straight to the new upload, regardless of shuffle —
        // "immediately" overrides the normal queued-insertion behavior below.
        setItems((prev) => {
          const next = [...prev];
          const insertAt = Math.min(indexRef.current + 1, next.length);
          next.splice(insertAt, 0, item);
          highlightItemIdRef.current = item.id;
          setIndex(insertAt);
          return next;
        });
      } else {
        // Videos keep the existing (non-interrupting) queued behavior.
        setItems((prev) => {
          const next = [...prev];
          const lower = Math.min(indexRef.current + 1, next.length);
          const insertAt = shuffleRef.current
            ? lower + Math.floor(Math.random() * (next.length - lower + 1))
            : lower;
          next.splice(insertAt, 0, item);
          return next;
        });
      }
    });

    // A whole reviewed archive-upload batch going live at once — quietly
    // queued in like a video, never highlighted like a fresh single upload
    // (approving dozens of photos together would otherwise mean dozens of
    // disruptive "New Upload" badges back to back).
    socket.on('media:approved', (item: MediaItem) => {
      setItems((prev) => {
        const next = [...prev];
        const lower = Math.min(indexRef.current + 1, next.length);
        const insertAt = shuffleRef.current
          ? lower + Math.floor(Math.random() * (next.length - lower + 1))
          : lower;
        next.splice(insertAt, 0, item);
        return next;
      });
    });

    socket.on('config:updated', (data: ConfigPayload) => {
      setImageDuration(data.slideshowIntervalMs);
      transitionStyleRef.current = data.transitionStyle;
      partyModeRef.current = data.partyMode;
      setSlideshowEnabled(data.slideshowEnabled);

      if (data.shuffle !== shuffleRef.current) {
        shuffleRef.current = data.shuffle;
        setShuffle(data.shuffle);
        // Re-fetch to get the stable chronological order back when turning
        // shuffle off, or a fresh random order when turning it on.
        fetch('/api/media')
          .then((r) => r.json())
          .then((mediaData: MediaItem[]) => {
            setItems(data.shuffle ? shuffleArray(mediaData) : mediaData);
            setIndex(0);
          });
      }
    });

    socket.on('media:updated', (updated: MediaItem) => {
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    });

    socket.on('media:deleted', ({ id }: { id: string }) => {
      setItems((prev) => {
        const deleteIdx = prev.findIndex((i) => i.id === id);
        if (deleteIdx === -1) return prev;
        const next = prev.filter((i) => i.id !== id);

        // Keep the slideshow pointed at the same logical item: shift the
        // index down if something before it was removed, otherwise clamp it
        // into the shrunk array (deleting the current item just slides the
        // next one into its place).
        const curIdx = indexRef.current;
        setIndex(next.length === 0 ? 0 : deleteIdx < curIdx ? (curIdx - 1) % next.length : curIdx % next.length);

        return next;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  function advance() {
    setIndex((i) => {
      if (items.length === 0) return 0;
      const next = (i + 1) % items.length;
      // Looping back to the start is a natural point to re-shuffle, so a
      // full pass through the gallery doesn't always replay in the same
      // random order.
      if (next === 0 && shuffleRef.current) {
        setItems((prev) => shuffleArray(prev));
      }
      return next;
    });
  }

  // Called when a highlight's 10 seconds are up. If another upload queued up
  // while this one was playing, jump straight to it — otherwise resume
  // normal rotation. Skips over any queued item that got deleted before its
  // turn instead of getting stuck on it.
  //
  // Deliberately a plain function reading itemsRef (not a setItems updater):
  // React (in StrictMode dev builds) may invoke a setState updater twice to
  // check it's pure, and highlightQueueRef.current.shift() is not idempotent
  // — a second invocation would silently discard an extra queued item.
  function playNextHighlightOrAdvance() {
    while (highlightQueueRef.current.length > 0) {
      const queued = highlightQueueRef.current.shift()!;
      const idx = itemsRef.current.findIndex((i) => i.id === queued.id);
      if (idx !== -1) {
        highlightItemIdRef.current = queued.id;
        setIndex(idx);
        return;
      }
    }
    advance();
  }

  useEffect(() => {
    if (!current) return undefined;
    const isNewUpload = highlightItemIdRef.current === current.id;
    highlightActiveRef.current = isNewUpload;

    // Picked once per slide (not on every re-render) so an unrelated state
    // change — e.g. tapping unmute — doesn't reshuffle or interrupt the
    // transition that's already playing.
    setTransitionClass(pickTransitionClass(transitionStyleRef.current, partyModeRef.current));
    setShowNewUploadBadge(isNewUpload);

    if (timerRef.current) clearTimeout(timerRef.current);
    if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);

    if (isNewUpload) {
      timerRef.current = setTimeout(() => {
        highlightItemIdRef.current = null;
        playNextHighlightOrAdvance();
      }, NEW_UPLOAD_DISPLAY_MS);
      badgeTimerRef.current = setTimeout(() => setShowNewUploadBadge(false), NEW_UPLOAD_BADGE_MS);
    } else if (current.kind === 'image') {
      timerRef.current = setTimeout(advance, imageDuration);
    }
    // videos (not a highlighted new upload) advance via onEnded, no timer.

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    };
    // Deliberately keyed on current?.id rather than items/items.length: an
    // upload queueing (or any other change to items that doesn't affect
    // what's actually being displayed right now) must NOT reset this timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, imageDuration]);

  if (!slideshowEnabled) {
    return (
      <div className="page slideshow-page slideshow-empty">
        <h1 className="brand">
          <a href="/" className="brand-link">
            g33k<span>Vault</span>
          </a>
        </h1>
        <p>Slideshow is currently disabled.</p>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="page slideshow-page slideshow-empty">
        <h1 className="brand">
          <a href="/" className="brand-link">
            g33k<span>Vault</span>
          </a>
        </h1>
        <p>Waiting for the first upload…</p>
      </div>
    );
  }

  const src = `/media/${current.filename}?v=${current.size}`;

  return (
    <div className="page slideshow-page">
      <div key={current.id} className={`slide-frame ${transitionClass}`}>
        {current.kind === 'image' ? (
          <img src={src} className="slide" alt="" />
        ) : (
          <video src={src} className="slide" autoPlay muted={muted} onEnded={advance} />
        )}
      </div>
      {current.kind === 'video' && muted && (
        <button className="unmute-btn" onClick={() => setMuted(false)} aria-label="Unmute video">
          🔇 Tap for sound
        </button>
      )}
      {current.uploader && <div className="slide-uploader-tag">{current.uploader}</div>}
      {current.kind === 'image' && current.photo_taken_at != null && (
        <div className="slide-photo-date-tag">{formatPhotoDate(current.photo_taken_at)}</div>
      )}
      {showNewUploadBadge && <div className="new-upload-badge">🆕 New Upload</div>}
    </div>
  );
}
