import { useEffect, useState } from 'react';

export default function Host() {
  const [uploadUrl, setUploadUrl] = useState('');

  useEffect(() => {
    fetch('/api/upload-url')
      .then((r) => r.json())
      .then((data) => setUploadUrl(data.url));
  }, []);

  return (
    <div className="page host-page">
      <h1 className="brand">
        g33k<span>Vault</span>
      </h1>
      <p className="tagline">Scan to add your photos &amp; videos to the live show</p>

      <div className="qr-wrap">
        <img src="/api/qrcode" alt="Scan to upload" className="qr-code" />
      </div>

      {uploadUrl && <p className="upload-url">{uploadUrl}</p>}

      <a href="/slideshow" className="btn btn-primary" target="_blank" rel="noreferrer">
        Launch Slideshow
      </a>

      <a href="/admin" className="admin-link">
        Admin
      </a>
    </div>
  );
}
