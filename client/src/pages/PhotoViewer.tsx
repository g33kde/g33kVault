import { useEffect, useState } from 'react';

interface MediaItem {
  id: string;
  filename: string;
  kind: 'image' | 'video';
  size: number;
}

// Opened by Admin.tsx via window.open() as a separate popup window — click
// the photo to close it (window.close() only works reliably on a window
// opened by script, which is exactly what this is), or use the side arrows
// to step through the same set of photos the admin grid shows, in the same
// order, without closing.
export default function PhotoViewer() {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('id')
  );

  useEffect(() => {
    fetch('/api/media')
      .then((r) => r.json())
      .then((data: MediaItem[]) => {
        // Images only (matches which thumbnails open this viewer in the
        // first place), newest-first — the same order the admin grid shows.
        setItems([...data].filter((i) => i.kind === 'image').reverse());
      });
  }, []);

  function go(item: MediaItem) {
    setCurrentId(item.id);
    const url = new URL(window.location.href);
    url.searchParams.set('id', item.id);
    window.history.replaceState(null, '', url.toString());
  }

  if (!items || !currentId) {
    return (
      <div className="page">
        <p className="tagline">Loading…</p>
      </div>
    );
  }

  const index = items.findIndex((i) => i.id === currentId);
  const current = index === -1 ? null : items[index];

  if (!current) {
    return (
      <div className="page">
        <p className="tagline">Photo not found — it may have been deleted.</p>
      </div>
    );
  }

  const prev = index > 0 ? items[index - 1] : null;
  const next = index < items.length - 1 ? items[index + 1] : null;

  return (
    <div className="photo-viewer-page">
      {prev && (
        <button
          type="button"
          className="photo-viewer-arrow photo-viewer-arrow-left"
          onClick={() => go(prev)}
          aria-label="Previous photo"
        >
          ‹
        </button>
      )}
      <img
        className="photo-viewer-image"
        src={`/media/${current.filename}?v=${current.size}`}
        alt=""
        onClick={() => window.close()}
      />
      {next && (
        <button
          type="button"
          className="photo-viewer-arrow photo-viewer-arrow-right"
          onClick={() => go(next)}
          aria-label="Next photo"
        >
          ›
        </button>
      )}
    </div>
  );
}
