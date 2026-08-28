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
        g33k<span>Vault</span>
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

      <div className="qr-wrap">
        <img src={`/api/qrcode?dest=${dest}`} alt="Scan to open g33kVault" className="qr-code" />
      </div>

      {url && <p className="upload-url">{url}</p>}

      <a href="/slideshow" className="btn btn-primary" target="_blank" rel="noreferrer">
        Launch Slideshow
      </a>

      <a href="/admin" className="admin-link">
        Admin
      </a>
    </div>
  );
}
