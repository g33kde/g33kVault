import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface MediaItem {
  id: string;
  filename: string;
  mime_type: string;
  kind: 'image' | 'video';
  created_at: number;
}

type TransitionStyle = 'none' | 'fade' | 'zoom' | 'polaroid' | 'glitch' | 'arcade' | 'vhs' | 'random';

interface ConfigPayload {
  slideshowIntervalMs: number;
  shuffle: boolean;
  transitionStyle: TransitionStyle;
  partyMode: boolean;
}

const DEFAULT_IMAGE_DURATION_MS = 6000;

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
  const [muted, setMuted] = useState(true);
  const [transitionClass, setTransitionClass] = useState('');
  const indexRef = useRef(0);
  const shuffleRef = useRef(false);
  const transitionStyleRef = useRef<TransitionStyle>('none');
  const partyModeRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

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
      setItems(configData.shuffle ? shuffleArray(mediaData) : mediaData);
    });

    const socket: Socket = io({ path: '/socket.io' });

    socket.on('media:new', (item: MediaItem) => {
      setItems((prev) => {
        const next = [...prev];
        // In shuffle mode, drop the new item anywhere in the not-yet-shown
        // portion of the queue instead of always right after the current
        // one, so it doesn't defeat the randomization.
        const lower = Math.min(indexRef.current + 1, next.length);
        const insertAt = shuffleRef.current ? lower + Math.floor(Math.random() * (next.length - lower + 1)) : lower;
        next.splice(insertAt, 0, item);
        return next;
      });
    });

    socket.on('config:updated', (data: ConfigPayload) => {
      setImageDuration(data.slideshowIntervalMs);
      transitionStyleRef.current = data.transitionStyle;
      partyModeRef.current = data.partyMode;

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

  useEffect(() => {
    if (items.length === 0) return undefined;
    const current = items[index % items.length];

    // Picked once per slide (not on every re-render) so an unrelated state
    // change — e.g. tapping unmute — doesn't reshuffle or interrupt the
    // transition that's already playing.
    setTransitionClass(pickTransitionClass(transitionStyleRef.current, partyModeRef.current));

    if (timerRef.current) clearTimeout(timerRef.current);

    if (current.kind === 'image') {
      timerRef.current = setTimeout(advance, imageDuration);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items.length, imageDuration]);

  if (items.length === 0) {
    return (
      <div className="page slideshow-page slideshow-empty">
        <h1 className="brand">
          g33k<span>Vault</span>
        </h1>
        <p>Waiting for the first upload…</p>
      </div>
    );
  }

  const current = items[index % items.length];
  const src = `/media/${current.filename}`;

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
    </div>
  );
}
