import { useState } from 'react';

type Status = 'idle' | 'uploading' | 'success' | 'error';

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setPreview(URL.createObjectURL(selected));
    setStatus('idle');
  }

  async function handleUpload() {
    if (!file) return;

    setStatus('uploading');
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Upload failed');
      }
      setStatus('success');
      setFile(null);
      setPreview(null);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  }

  function reset() {
    setStatus('idle');
    setFile(null);
    setPreview(null);
  }

  const fileKind = file?.type.startsWith('video') ? 'video' : 'image';

  return (
    <div className="page upload-page">
      <h1 className="brand">
        g33k<span>Vault</span>
      </h1>

      {status === 'success' ? (
        <div className="success-panel">
          <p>Uploaded! It&apos;ll show up in the slideshow shortly.</p>
          <button className="btn btn-primary" onClick={reset}>
            Upload another
          </button>
        </div>
      ) : (
        <>
          {!preview && (
            <label className="file-picker">
              Choose photo or video
              <input type="file" accept="image/*,video/*" onChange={handleFileChange} hidden />
            </label>
          )}

          {preview && fileKind === 'image' && <img src={preview} className="preview" alt="preview" />}
          {preview && fileKind === 'video' && <video src={preview} className="preview" controls />}

          {preview && (
            <div className="actions">
              <button className="btn btn-primary" onClick={handleUpload} disabled={status === 'uploading'}>
                {status === 'uploading' ? 'Uploading…' : 'Upload'}
              </button>
              <button className="btn btn-secondary" onClick={reset} disabled={status === 'uploading'}>
                Cancel
              </button>
            </div>
          )}

          {status === 'error' && <p className="error-msg">{error}</p>}
        </>
      )}
    </div>
  );
}
