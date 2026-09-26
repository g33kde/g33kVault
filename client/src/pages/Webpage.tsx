import { useCallback, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface MediaItem {
  id: string;
  filename: string;
  kind: 'image' | 'video';
  size: number;
  uploader?: string | null;
}

// `?preview=1` lets an admin open the real page from /admin even while
// webpageEnabled is off for everyone else — same reasoning as Slideshow.tsx's
// isPreviewMode: no auth check needed, since the same media is already
// reachable unauthenticated via /api/media/-media/<filename> regardless of
// this flag. webpageEnabled just gates this particular presentation of it.
function isPreviewMode(): boolean {
  return new URLSearchParams(window.location.search).get('preview') === '1';
}

// A public, read-only counterpart to /admin's Photo Gallery grid — same
// approved photos/videos, same grid styling (.admin-grid/.admin-thumb,
// reused rather than duplicated), but no admin actions: no rotate, no
// delete, no select mode. Gated behind its own webpageEnabled toggle
// (Playback Settings) rather than always being reachable, since unlike
// /slideshow this is a brand-new page with no existing behavior to
// preserve — off by default until an admin opts in.
export default function Webpage() {
  const isPreview = isPreviewMode();
  // null = not loaded yet (show a loading state, not a flash of "disabled").
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [eventImageUrl, setEventImageUrl] = useState<string | null>(null);
  const [eventImageScale, setEventImageScale] = useState(100);

  // Same window.open() popup mechanism Admin.tsx's openPhotoViewer uses —
  // PhotoViewer.tsx relies on window.close() when the photo itself is
  // clicked, which only works on a script-opened window, not a plain
  // navigated-to page.
  const openPhotoViewer = useCallback((id: string) => {
    window.open(
      `/photo-viewer?id=${encodeURIComponent(id)}`,
      'g33kvault-photo-viewer',
      'width=1100,height=850,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes,popup=1'
    );
  }, []);

  useEffect(() => {
    type ConfigData = { webpageEnabled: boolean; eventImageUrl: string | null; eventImageScale: number };
    const applyConfig = (data: ConfigData) => {
      setEnabled(data.webpageEnabled);
      setEventImageUrl(data.eventImageUrl);
      setEventImageScale(data.eventImageScale);
    };

    fetch('/api/config')
      .then((r) => r.json())
      .then(applyConfig);

    fetch('/api/media')
      .then((r) => r.json())
      .then(setItems);

    const socket: Socket = io({ path: '/socket.io' });
    // Lets an admin flip the toggle live (on or off), or change the event
    // image, without anyone already on this page needing to refresh — same
    // idea as how Slideshow.tsx reacts to config changes mid-show.
    socket.on('config:updated', applyConfig);
    socket.on('media:new', (item: MediaItem) => setItems((prev) => [...prev, item]));
    socket.on('media:approved', (item: MediaItem) => setItems((prev) => [...prev, item]));
    socket.on('media:restored', (item: MediaItem) => setItems((prev) => [...prev, item]));
    socket.on('media:deleted', ({ id }: { id: string }) => setItems((prev) => prev.filter((i) => i.id !== id)));
    socket.on('media:updated', (updated: MediaItem) =>
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    );

    return () => {
      socket.disconnect();
    };
  }, []);

  if (enabled === null) {
    return (
      <div className="page">
        <p className="tagline">Loading…</p>
      </div>
    );
  }

  if (!enabled && !isPreview) {
    return (
      <div className="page">
        <h1 className="brand">
          <a href="/" className="brand-link">
            g33k<span>Vault</span>
          </a>
        </h1>
        <p>This page is currently unavailable.</p>
      </div>
    );
  }

  // Newest-first, same order the admin gallery grid shows.
  const reversed = [...items].reverse();

  return (
    <div className="page webpage-page">
      {!enabled && isPreview && (
        <div className="webpage-preview-badge">🔍 Admin preview — disabled for guests</div>
      )}
      {eventImageUrl && (
        <img
          src={eventImageUrl}
          className="webpage-event-image"
          alt=""
          style={{ '--event-image-scale': eventImageScale / 100 } as React.CSSProperties}
        />
      )}
      <h1 className="brand">
        <a href="/" className="brand-link">
          g33k<span>Vault</span>
        </a>
      </h1>
      {items.length === 0 ? (
        <p className="tagline">No photos yet.</p>
      ) : (
        <>
          <p className="tagline">
            {items.length} item{items.length === 1 ? '' : 's'}
          </p>
          <div className="admin-grid">
            {reversed.map((item) => (
              <div key={item.id} className="admin-thumb">
                {item.kind === 'video' ? (
                  <video src={`/media/${item.filename}`} controls muted playsInline />
                ) : (
                  <button type="button" className="admin-thumb-open-btn" onClick={() => openPhotoViewer(item.id)}>
                    <img src={`/media/${item.filename}?v=${item.size}`} alt="" loading="lazy" />
                  </button>
                )}
                {item.uploader && (
                  <span className="admin-thumb-uploader" title={item.uploader}>
                    {item.uploader}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
