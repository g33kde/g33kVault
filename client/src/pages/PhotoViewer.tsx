import { useEffect, useRef, useState } from 'react';

interface MediaItem {
  id: string;
  filename: string;
  kind: 'image' | 'video';
  size: number;
}

// How long the mouse can sit still before the arrows fade out — long enough
// to read/click comfortably, short enough that they're out of the way for
// someone just looking at the photo.
const ARROW_IDLE_MS = 800;

// Minimum horizontal drag, in px, before a touch gesture counts as a swipe
// rather than a tap/scroll — well above accidental-finger-wobble territory,
// well below "clearly means to change photos."
const SWIPE_THRESHOLD_PX = 50;

// Opened by Admin.tsx (and Webpage.tsx) via window.open() as a separate
// popup window — click the photo to close it (window.close() only works
// reliably on a window opened by script, which is exactly what this is), or
// use the side arrows to step through the same set of photos the calling
// page's grid shows, in the same order, without closing. The arrows fade
// out after a couple of seconds of no mouse movement so they don't clutter
// the photo while it's just being looked at, and fade back in on the next
// movement.
export default function PhotoViewer() {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('id')
  );
  const [arrowsIdle, setArrowsIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    fetch('/api/media')
      .then((r) => r.json())
      .then((data: MediaItem[]) => {
        // Images only (matches which thumbnails open this viewer in the
        // first place), newest-first — the same order the admin grid shows.
        setItems([...data].filter((i) => i.kind === 'image').reverse());
      });
  }, []);

  useEffect(() => {
    function wake() {
      setArrowsIdle(false);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setArrowsIdle(true), ARROW_IDLE_MS);
    }

    // touchstart too — /webpage's guests are mostly on phones, which never
    // fire mousemove, so mouse-only would leave the arrows permanently
    // hidden after the first idle timeout on touch devices.
    window.addEventListener('mousemove', wake);
    window.addEventListener('touchstart', wake);
    idleTimer.current = setTimeout(() => setArrowsIdle(true), ARROW_IDLE_MS);

    return () => {
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('touchstart', wake);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
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

  // Swipe left (finger moves left, dx negative) goes to the next photo,
  // same direction as the right arrow; swipe right goes to the previous
  // one. Requires the horizontal drag to both clear SWIPE_THRESHOLD_PX and
  // dominate the vertical movement, so an ordinary vertical scroll attempt
  // doesn't get misread as a swipe. A real swipe's touchmove naturally
  // suppresses the browser's synthetic click on release, so this doesn't
  // fight with the image's tap-to-close handler below.
  function handleTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy)) return;

    if (dx < 0 && next) go(next);
    else if (dx > 0 && prev) go(prev);
  }

  return (
    <div className="photo-viewer-page" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {prev && (
        <button
          type="button"
          className={`photo-viewer-arrow photo-viewer-arrow-left ${arrowsIdle ? 'photo-viewer-arrow-idle' : ''}`}
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
          className={`photo-viewer-arrow photo-viewer-arrow-right ${arrowsIdle ? 'photo-viewer-arrow-idle' : ''}`}
          onClick={() => go(next)}
          aria-label="Next photo"
        >
          ›
        </button>
      )}
    </div>
  );
}
