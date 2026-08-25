import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface MediaItem {
  id: string;
  filename: string;
  mime_type: string;
  kind: 'image' | 'video';
  created_at: number;
}

const DEFAULT_IMAGE_DURATION_MS = 6000;

export default function Slideshow() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [index, setIndex] = useState(0);
  const [imageDuration, setImageDuration] = useState(DEFAULT_IMAGE_DURATION_MS);
  const indexRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    fetch('/api/media')
      .then((r) => r.json())
      .then((data: MediaItem[]) => setItems(data));

    fetch('/api/config')
      .then((r) => r.json())
      .then((data: { slideshowIntervalMs: number }) => setImageDuration(data.slideshowIntervalMs));

    const socket: Socket = io({ path: '/socket.io' });

    socket.on('media:new', (item: MediaItem) => {
      setItems((prev) => {
        const next = [...prev];
        const insertAt = Math.min(indexRef.current + 1, next.length);
        next.splice(insertAt, 0, item);
        return next;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  function advance() {
    setIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
  }

  useEffect(() => {
    if (items.length === 0) return undefined;
    const current = items[index % items.length];

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
      {current.kind === 'image' ? (
        <img key={current.id} src={src} className="slide" alt="" />
      ) : (
        <video key={current.id} src={src} className="slide" autoPlay muted onEnded={advance} />
      )}
    </div>
  );
}
