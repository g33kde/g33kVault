import { useRef, useState } from 'react';

type Status = 'idle' | 'uploading' | 'success' | 'error';

export default function Upload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<'image' | 'video' | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setFileKind(file.type.startsWith('video') ? 'video' : 'image');
    setStatus('idle');
  }

  async function handleUpload() {
    const file = inputRef.current?.files?.[0];
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
      setPreview(null);
      setFileKind(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  }

  function reset() {
    setStatus('idle');
    setPreview(null);
    setFileKind(null);
    if (inputRef.current) inputRef.current.value = '';
  }

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
              <input
                ref={inputRef}
                type="file"
                accept="image/*,video/*"
                onChange={handleFileChange}
                hidden
              />
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
