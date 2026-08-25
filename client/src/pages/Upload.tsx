import { useEffect, useState } from 'react';

type Status = 'idle' | 'uploading' | 'done';

interface UploadResult {
  name: string;
  ok: boolean;
  error?: string;
}

const THUMB_LIMIT = 12;

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<UploadResult[]>([]);

  useEffect(() => {
    const toPreview = files.length === 1 ? files : files.slice(0, THUMB_LIMIT);
    const urls = toPreview.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [files]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    setFiles(selected);
    setStatus('idle');
    setResults([]);
  }

  async function handleUpload() {
    if (files.length === 0) return;
    setStatus('uploading');
    setProgress(0);
    const outcomes: UploadResult[] = [];

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (res.ok) {
          outcomes.push({ name: file.name, ok: true });
        } else {
          const data = await res.json().catch(() => ({}));
          outcomes.push({ name: file.name, ok: false, error: data.error || 'Upload failed' });
        }
      } catch {
        outcomes.push({ name: file.name, ok: false, error: 'Network error' });
      }
      setProgress((p) => p + 1);
    }

    setResults(outcomes);
    setStatus('done');
    setFiles([]);
  }

  function reset() {
    setStatus('idle');
    setFiles([]);
    setResults([]);
    setProgress(0);
  }

  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);

  return (
    <div className="page upload-page">
      <h1 className="brand">
        g33k<span>Vault</span>
      </h1>

      {status === 'done' ? (
        <div className="success-panel">
          <p>
            {succeeded.length} uploaded{failed.length > 0 ? `, ${failed.length} failed` : ''}.
          </p>
          {failed.length > 0 && (
            <ul className="fail-list">
              {failed.map((f) => (
                <li key={f.name}>
                  {f.name}: {f.error}
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-primary" onClick={reset}>
            Upload more
          </button>
        </div>
      ) : (
        <>
          {files.length === 0 && (
            <label className="file-picker">
              Choose photos or videos
              <input type="file" accept="image/*,video/*" multiple onChange={handleFileChange} hidden />
            </label>
          )}

          {files.length === 1 &&
            status === 'idle' &&
            (files[0].type.startsWith('video') ? (
              <video src={previewUrls[0]} className="preview" controls />
            ) : (
              <img src={previewUrls[0]} className="preview" alt="preview" />
            ))}

          {files.length > 1 && status === 'idle' && (
            <div className="thumb-grid">
              {previewUrls.map((url, i) => (
                <div key={i} className="thumb">
                  {files[i].type.startsWith('video') ? (
                    <video src={url} muted />
                  ) : (
                    <img src={url} alt="" />
                  )}
                </div>
              ))}
              {files.length > THUMB_LIMIT && (
                <div className="thumb thumb-more">+{files.length - THUMB_LIMIT}</div>
              )}
            </div>
          )}

          {files.length > 0 && status === 'idle' && (
            <div className="actions">
              <button className="btn btn-primary" onClick={handleUpload}>
                {files.length === 1 ? 'Upload' : `Upload all ${files.length}`}
              </button>
              <button className="btn btn-secondary" onClick={reset}>
                Cancel
              </button>
            </div>
          )}

          {status === 'uploading' && (
            <p>
              Uploading {progress} / {files.length}…
            </p>
          )}
        </>
      )}
    </div>
  );
}
