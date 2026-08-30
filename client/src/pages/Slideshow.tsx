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
type CollageMode = 'off' | 'always' | 'mixed';
type CollageLayout =
  | 'diagonal-2'
  | 'big-plus-2'
  | 'grid-4'
  | 'feature-4'
  | 'grid-6'
  | 'scatter-6'
  | 'scatter-6-2'
  | 'scatter-6-3'
  | 'scatter-6-4'
  | 'scatter-6-5'
  | 'scatter-6-6'
  | 'random';
type ConcreteCollageLayout = Exclude<CollageLayout, 'random'>;

interface ConfigPayload {
  slideshowIntervalMs: number;
  shuffle: boolean;
  transitionStyle: TransitionStyle;
  partyMode: boolean;
  slideshowEnabled: boolean;
  collageMode: CollageMode;
  collageLayout: CollageLayout;
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

// How many photos each layout needs — fixed by its geometry (see the CSS
// classes .collage-* in global.css, and the mockup this was designed from).
const COLLAGE_LAYOUT_PHOTO_COUNTS: Record<ConcreteCollageLayout, number> = {
  'diagonal-2': 2,
  'big-plus-2': 3,
  'grid-4': 4,
  'feature-4': 4,
  'grid-6': 6,
  'scatter-6': 6,
  'scatter-6-2': 6,
  'scatter-6-3': 6,
  'scatter-6-4': 6,
  'scatter-6-5': 6,
  'scatter-6-6': 6,
};
const CONCRETE_COLLAGE_LAYOUTS = Object.keys(COLLAGE_LAYOUT_PHOTO_COUNTS) as ConcreteCollageLayout[];

// "Mixed" mode: every Nth non-highlight turn is a collage, the rest stay
// single-photo. Not admin-configurable yet — a fixed default for this first
// version.
const MIXED_MODE_COLLAGE_EVERY = 4;

interface CollagePick {
  layout: ConcreteCollageLayout;
  photos: MediaItem[];
  // How many array slots (starting at the collage's start index) this pick
  // actually used, including any videos skipped along the way — advance()
  // moves the index forward by exactly this much, not just 1.
  consumed: number;
}

// Scans forward from startIndex collecting up to 6 images (the most any
// layout needs), skipping videos — collages never include a video (multiple
// autoplaying videos with audio at once would be chaotic, and a tile-sized
// video loses most of its point). Picks whichever layout the admin chose
// (or a random one), falling back to a smaller layout — or no collage at
// all, if fewer than 2 images are available right now — rather than
// showing a layout with empty gaps on a small gallery.
function pickCollageSet(allItems: MediaItem[], startIndex: number, layoutSetting: CollageLayout): CollagePick | null {
  const total = allItems.length;
  if (total === 0) return null;

  const collectedOffsets: number[] = [];
  for (let offset = 0; offset < total && collectedOffsets.length < 6; offset++) {
    const item = allItems[(startIndex + offset) % total];
    if (item.kind === 'image') collectedOffsets.push(offset);
  }
  if (collectedOffsets.length < 2) return null;

  let layout: ConcreteCollageLayout;
  if (layoutSetting === 'random') {
    const candidates = CONCRETE_COLLAGE_LAYOUTS.filter(
      (l) => COLLAGE_LAYOUT_PHOTO_COUNTS[l] <= collectedOffsets.length
    );
    layout = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    // Fallback to the lightest layout (needs only 2 photos, always
    // satisfiable given the >=2 check above) when the configured layout
    // needs more photos than are currently available — or when a stored
    // setting names a layout that no longer exists (e.g. a removed one).
    layout = COLLAGE_LAYOUT_PHOTO_COUNTS[layoutSetting] <= collectedOffsets.length ? layoutSetting : 'diagonal-2';
  }

  const needed = COLLAGE_LAYOUT_PHOTO_COUNTS[layout];
  const usedOffsets = collectedOffsets.slice(0, needed);
  const photos = usedOffsets.map((o) => allItems[(startIndex + o) % total]);
  const consumed = usedOffsets[usedOffsets.length - 1] + 1;
  return { layout, photos, consumed };
}

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
  const [collagePick, setCollagePick] = useState<CollagePick | null>(null);
  const indexRef = useRef(0);
  const itemsRef = useRef<MediaItem[]>([]);
  const shuffleRef = useRef(false);
  const transitionStyleRef = useRef<TransitionStyle>('none');
  const partyModeRef = useRef(false);
  const collageModeRef = useRef<CollageMode>('off');
  const collageLayoutRef = useRef<CollageLayout>('random');
  // How many array slots the slide currently on screen occupies — 1 for a
  // single photo/video/highlight, or a collage's full consumed count.
  // advance() steps the index forward by this, not always by 1.
  const slideStepRef = useRef(1);
  // Cadence counter for "mixed" mode — incremented once per non-highlight
  // turn, a collage happens every MIXED_MODE_COLLAGE_EVERY-th one.
  const mixedModeCounterRef = useRef(0);
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
      collageModeRef.current = configData.collageMode;
      collageLayoutRef.current = configData.collageLayout;
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
      collageModeRef.current = data.collageMode;
      collageLayoutRef.current = data.collageLayout;
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
      // A collage just shown steps forward by however many array slots it
      // actually used (see slideStepRef), not always 1.
      const step = slideStepRef.current || 1;
      const next = (i + step) % items.length;
      // Wrapping past the start is a natural point to re-shuffle, so a full
      // pass through the gallery doesn't always replay in the same random
      // order. A multi-step collage advance can jump past 0 without landing
      // on it exactly, so this checks for that instead of `next === 0`.
      if (i + step >= items.length && shuffleRef.current) {
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
      // A fresh upload always gets the existing full-screen single-photo
      // treatment, even if collage mode is on — collage rotation resumes
      // right after.
      setCollagePick(null);
      slideStepRef.current = 1;
      timerRef.current = setTimeout(() => {
        highlightItemIdRef.current = null;
        playNextHighlightOrAdvance();
      }, NEW_UPLOAD_DISPLAY_MS);
      badgeTimerRef.current = setTimeout(() => setShowNewUploadBadge(false), NEW_UPLOAD_BADGE_MS);
    } else {
      let collage: CollagePick | null = null;
      const mode = collageModeRef.current;
      if (mode === 'always') {
        collage = pickCollageSet(itemsRef.current, indexRef.current, collageLayoutRef.current);
      } else if (mode === 'mixed') {
        mixedModeCounterRef.current += 1;
        if (mixedModeCounterRef.current % MIXED_MODE_COLLAGE_EVERY === 0) {
          collage = pickCollageSet(itemsRef.current, indexRef.current, collageLayoutRef.current);
        }
      }

      setCollagePick(collage);
      slideStepRef.current = collage ? collage.consumed : 1;

      if (collage || current.kind === 'image') {
        timerRef.current = setTimeout(advance, imageDuration);
      }
      // a solo video (no collage) advances via onEnded, no timer.
    }

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

  if (collagePick) {
    return (
      <div className="page slideshow-page">
        <div
          key={collagePick.photos.map((p) => p.id).join('-')}
          className={`collage-frame collage-${collagePick.layout} ${transitionClass}`}
        >
          {collagePick.photos.map((photo, i) => (
            <div key={photo.id} className={`collage-tile collage-tile-${i + 1}`}>
              <img src={`/media/${photo.filename}?v=${photo.size}`} alt="" />
            </div>
          ))}
        </div>
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
