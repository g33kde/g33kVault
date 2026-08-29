import { useEffect, useState } from 'react';

type Dest = 'upload' | 'booth';

export default function Host() {
  const [dest, setDest] = useState<Dest>('upload');
  const [url, setUrl] = useState('');

  useEffect(() => {
    fetch(`/api/upload-url?dest=${dest}`)
      .then((r) => r.json())
      .then((data) => setUrl(data.url));
  }, [dest]);

  return (
    <div className="page host-page">
      <h1 className="brand">
        <a href="/" className="brand-link">
          g33k<span>Vault</span>
        </a>
      </h1>
      <p className="tagline">
        {dest === 'upload'
          ? 'Scan to add your photos & videos to the live show'
          : 'Scan to jump into the photo booth'}
      </p>

      <div className="dest-toggle">
        <button
          className={`btn ${dest === 'upload' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setDest('upload')}
        >
          Upload QR
        </button>
        <button
          className={`btn ${dest === 'booth' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setDest('booth')}
        >
          📸 Booth QR
        </button>
      </div>

      {url ? (
        <a href={url} className="qr-wrap" aria-label={`Open ${dest === 'upload' ? 'the upload page' : 'the photo booth'}`}>
          <img src={`/api/qrcode?dest=${dest}`} alt="Scan or tap to open g33kVault" className="qr-code" />
        </a>
      ) : (
        <div className="qr-wrap">
          <img src={`/api/qrcode?dest=${dest}`} alt="Scan to open g33kVault" className="qr-code" />
        </div>
      )}

      {url && (
        <a href={url} className="upload-url">
          {url}
        </a>
      )}

      <a href="/slideshow" className="btn btn-primary" target="_blank" rel="noreferrer">
        Launch Slideshow
      </a>

      <a href="/admin" className="admin-link">
        Admin
      </a>
    </div>
  );
}
