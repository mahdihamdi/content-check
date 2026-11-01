import { useCallback, useEffect, useRef, useState } from "react";
import { analyzeFile } from "./lib/analyze";
import { isImageFile } from "./lib/file";
import { MAX_EDGE_PX, MAX_FILE_MB, sanitizeDisplay, validateImageFile } from "./lib/guard";
import { preloadVisualModel } from "./lib/visual";
import type { AnalysisJob, AnalysisResult, Likelihood } from "./lib/types";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/tiff,image/avif,.jpg,.jpeg,.png,.webp";
const MAX_BATCH = 40;

const SAMPLES = [
  {
    label: "camera photo",
    url: "/samples/photo.jpg",
    name: "photo.jpg",
  },
  {
    label: "AI metadata sample",
    url: "/samples/ai-metadata.png",
    name: "ai-metadata.png",
  },
];

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function verdictLabel(v: Likelihood) {
  if (v === "ai") return "Likely AI-generated";
  if (v === "authentic") return "Likely authentic";
  return "Inconclusive";
}

function safeError(err: unknown, fallback: string) {
  return sanitizeDisplay(err instanceof Error ? err.message : fallback, 180);
}

function makeJob(file: File): AnalysisJob {
  return {
    id: crypto.randomUUID(),
    file,
    fileName: sanitizeDisplay(file.name, 120) || "image",
    fileSize: file.size,
    previewUrl: URL.createObjectURL(file),
    status: "queued",
    error: null,
    result: null,
  };
}

function c2paLabel(result: AnalysisResult) {
  if (!result.c2pa.present) return "Not found";
  if (result.c2pa.generative) return "Generative";
  if (result.c2pa.cameraCapture) return "Captured";
  return "Present";
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const jobsRef = useRef<AnalysisJob[]>([]);
  const processing = useRef(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const syncJobs = useCallback((updater: (prev: AnalysisJob[]) => AnalysisJob[]) => {
    const next = updater(jobsRef.current);
    jobsRef.current = next;
    setJobs(next);
  }, []);

  useEffect(() => {
    preloadVisualModel();
    return () => {
      for (const job of jobsRef.current) URL.revokeObjectURL(job.previewUrl);
    };
  }, []);

  const processQueue = useCallback(async () => {
    if (processing.current) return;
    processing.current = true;

    while (true) {
      const next = jobsRef.current.find((job) => job.status === "queued");
      if (!next) break;

      syncJobs((prev) =>
        prev.map((job) => (job.id === next.id ? { ...job, status: "running", error: null } : job)),
      );

      try {
        await analyzeFile(next.file, next.previewUrl, (result) => {
          if (!jobsRef.current.some((job) => job.id === next.id)) return false;
          syncJobs((prev) =>
            prev.map((job) => (job.id === next.id ? { ...job, status: "running", result } : job)),
          );
          return true;
        });
        if (jobsRef.current.some((job) => job.id === next.id)) {
          syncJobs((prev) =>
            prev.map((job) => (job.id === next.id && job.status === "running" ? { ...job, status: "done" } : job)),
          );
        }
      } catch (err) {
        const message = safeError(err, "This image could not be analyzed.");
        if (jobsRef.current.some((job) => job.id === next.id)) {
          syncJobs((prev) =>
            prev.map((job) =>
              job.id === next.id ? { ...job, status: "error", error: message } : job,
            ),
          );
        }
      }
    }

    processing.current = false;
    if (jobsRef.current.some((job) => job.status === "queued")) {
      void processQueue();
    }
  }, [syncJobs]);

  const enqueueFiles = useCallback(
    async (incoming: File[]) => {
      const images = incoming.filter(isImageFile);
      const skipped = incoming.length - images.length;
      const room = Math.max(0, MAX_BATCH - jobsRef.current.length);
      const candidates = images.slice(0, room);
      const overflow = images.length - candidates.length;
      const accepted: File[] = [];
      const rejected: string[] = [];

      for (const file of candidates) {
        try {
          await validateImageFile(file);
          accepted.push(file);
        } catch (err) {
          const name = sanitizeDisplay(file.name, 60) || "image";
          rejected.push(`${name}: ${safeError(err, "This image was rejected.")}`);
        }
      }

      const roomNow = Math.max(0, MAX_BATCH - jobsRef.current.length);
      const toAdd = accepted.slice(0, roomNow);
      const notices: string[] = [];
      if (skipped) notices.push(`${skipped} file${skipped === 1 ? " was" : "s were"} skipped (not an image).`);
      if (overflow) notices.push(`Batch limit is ${MAX_BATCH} images. ${overflow} extra file${overflow === 1 ? "" : "s"} not added.`);
      if (rejected.length) notices.push(rejected.slice(0, 3).join(" "));
      setError(notices.length ? notices.join(" ") : null);

      if (!toAdd.length) return;

      const created = toAdd.map(makeJob);
      syncJobs((prev) => [...prev, ...created]);
      setSelectedId((current) => current ?? created[0].id);
      void processQueue();
    },
    [processQueue, syncJobs],
  );

  const onFiles = (list: FileList | File[] | null) => {
    if (!list || list.length === 0) return;
    enqueueFiles(Array.from(list));
  };

  const loadSamples = async (samples: typeof SAMPLES) => {
    try {
      const files = await Promise.all(
        samples.map(async (sample) => {
          const url = new URL(sample.url, window.location.origin);
          if (url.origin !== window.location.origin) throw new Error("Sample files must stay on this site.");
          const response = await fetch(url.href, {
            credentials: "same-origin",
            redirect: "error",
            referrerPolicy: "no-referrer",
          });
          if (!response.ok) throw new Error(`Could not download ${sample.name}.`);
          const blob = await response.blob();
          return new File([blob], sample.name, { type: blob.type || "image/jpeg" });
        }),
      );
      enqueueFiles(files);
    } catch (err) {
      setError(safeError(err, "Could not load the sample images."));
    }
  };

  const removeJob = (id: string) => {
    const job = jobsRef.current.find((item) => item.id === id);
    if (job) URL.revokeObjectURL(job.previewUrl);
    syncJobs((prev) => {
      const next = prev.filter((item) => item.id !== id);
      setSelectedId((current) => {
        if (current !== id) return current;
        const index = prev.findIndex((item) => item.id === id);
        return next[Math.min(index, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  };

  const clearAll = () => {
    for (const job of jobsRef.current) URL.revokeObjectURL(job.previewUrl);
    jobsRef.current = [];
    setJobs([]);
    setSelectedId(null);
    setError(null);
  };

  const selected = jobs.find((job) => job.id === selectedId) ?? jobs[0] ?? null;
  const result = selected?.result ?? null;
  const pending = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const counts = {
    ai: jobs.filter((job) => job.result?.verdict === "ai").length,
    authentic: jobs.filter((job) => job.result?.verdict === "authentic").length,
    inconclusive: jobs.filter((job) => job.result?.verdict === "inconclusive").length,
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden>
            Cc
          </div>
          <div>
            <h1>Content Check</h1>
            <p>Find whether images were generated by AI</p>
          </div>
        </div>
        <div className="pill">Runs in your browser · files stay on this device</div>
      </header>

      <section className="hero">
        <div>
          <h2>Drop images. Check provenance, then pixels.</h2>
          <p>
            Add a batch of photos or generated files. Content Check reads Adobe Content Credentials
            (C2PA), generator metadata, and a local visual classifier — one image at a time so the
            browser stays responsive.
          </p>
        </div>
        <div
          className={`drop${drag ? " active" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setDrag(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDrag(false);
            onFiles(e.dataTransfer.files);
          }}
        >
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            multiple
            accept={ACCEPT}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div>
            <strong>{pending ? `Analyzing ${pending} of ${jobs.length}…` : "Drop photos or generated images"}</strong>
            <span>
              JPEG, PNG, WebP, GIF, TIFF, or AVIF · up to {MAX_FILE_MB} MB and {MAX_EDGE_PX}px · {MAX_BATCH} per
              batch
            </span>
          </div>
        </div>
      </section>

      {error ? <div className="error">{error}</div> : null}

      {jobs.length ? (
        <>
          <div className="batch-bar">
            <p>
              <strong>{jobs.length}</strong> {jobs.length === 1 ? "image" : "images"}
              {pending ? ` · ${pending} running` : ""}
              {counts.ai ? ` · ${counts.ai} AI` : ""}
              {counts.authentic ? ` · ${counts.authentic} authentic` : ""}
              {counts.inconclusive ? ` · ${counts.inconclusive} inconclusive` : ""}
            </p>
            <button type="button" className="text-btn" onClick={clearAll}>
              Clear batch
            </button>
          </div>

          <div className="queue" role="list">
            {jobs.map((job) => (
              <div
                key={job.id}
                role="listitem"
                className={`queue-item${selected?.id === job.id ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="queue-hit"
                  onClick={() => setSelectedId(job.id)}
                  aria-current={selected?.id === job.id}
                >
                  <img src={job.previewUrl} alt="" />
                  <span className={`queue-status ${job.result?.verdict ?? job.status}`}>
                    {job.status === "queued"
                      ? "Queued"
                      : job.status === "running"
                        ? "Running"
                        : job.status === "error"
                          ? "Error"
                          : verdictLabel(job.result?.verdict ?? "inconclusive")}
                  </span>
                  <span className="queue-name">{job.fileName}</span>
                </button>
                <button
                  type="button"
                  className="queue-remove"
                  aria-label={`Remove ${job.fileName}`}
                  onClick={() => removeJob(job.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="status">No images yet. Drop a batch or choose files to see verdicts.</p>
      )}

      {selected?.status === "error" && selected.error ? <div className="error">{selected.error}</div> : null}

      {result ? (
        <div className="layout">
          <aside className="preview-card">
            <img src={result.previewUrl} alt={result.fileName} />
            <div className="preview-meta">
              <strong>{result.fileName}</strong>
              {formatBytes(result.fileSize)}
              {result.metadata.width && result.metadata.height
                ? ` · ${result.metadata.width}×${result.metadata.height}`
                : ""}
              {jobs.length > 1 ? ` · ${jobs.findIndex((job) => job.id === selected?.id) + 1} of ${jobs.length}` : ""}
            </div>
          </aside>

          <section className="panel">
            <div className="verdict">
              <span className={`badge ${result.verdict}`}>{verdictLabel(result.verdict)}</span>
              <h3>{result.headline}</h3>
              <p>{result.summary}</p>
              <div className={`meter ${result.verdict}`} title="Confidence">
                <span style={{ width: `${Math.round(result.confidence * 100)}%` }} />
              </div>
            </div>

            <div className="grid">
              <article className="card">
                <h4>Content Credentials</h4>
                <div className="stat">{c2paLabel(result)}</div>
                <ul className="evidence">
                  {result.c2pa.evidence.map((item) => (
                    <li key={item.label}>
                      <b>{item.label}</b>
                      {item.detail}
                    </li>
                  ))}
                </ul>
                {result.c2pa.softwareAgents[0] ? (
                  <div className="dl">
                    <div>
                      Tool <span>{result.c2pa.softwareAgents[0]}</span>
                    </div>
                  </div>
                ) : null}
              </article>

              <article className="card">
                <h4>Metadata</h4>
                <div className="stat">{result.metadata.aiTool ?? (result.metadata.make ? "Camera EXIF" : "Sparse")}</div>
                <ul className="evidence">
                  {result.metadata.evidence.map((item) => (
                    <li key={item.label}>
                      <b>{item.label}</b>
                      {item.detail}
                    </li>
                  ))}
                </ul>
                <div className="dl">
                  {result.metadata.software ? (
                    <div>
                      Software <span>{result.metadata.software}</span>
                    </div>
                  ) : null}
                  {result.metadata.datetime ? (
                    <div>
                      Date <span>{result.metadata.datetime}</span>
                    </div>
                  ) : null}
                </div>
              </article>

              <article className="card">
                <h4>Visual model</h4>
                <div className="stat">
                  {result.visual.ready
                    ? `${Math.round(result.visual.aiScore * 100)}% AI`
                    : result.visual.error
                      ? "Unavailable"
                      : "Loading…"}
                </div>
                <ul className="evidence">
                  {result.visual.evidence.map((item) => (
                    <li key={item.label}>
                      <b>{item.label}</b>
                      {item.detail}
                    </li>
                  ))}
                </ul>
              </article>
            </div>
          </section>
        </div>
      ) : selected?.status === "queued" || selected?.status === "running" ? (
        <p className="status">Reading credentials, metadata, and running the visual detector…</p>
      ) : null}

      <div className="samples">
        <button type="button" onClick={() => void loadSamples(SAMPLES)}>
          Try both samples
        </button>
        {SAMPLES.map((sample) => (
          <button key={sample.label} type="button" onClick={() => void loadSamples([sample])}>
            Add {sample.label}
          </button>
        ))}
      </div>

      <p className="footnote">
        Detectors make mistakes. Missing Content Credentials does not prove a photo is real. Do not
        use this app as forensic evidence. Visual scoring uses the SMOGY AI-image detector in
        WebAssembly via Transformers.js. Images in a batch are analyzed sequentially.
      </p>
    </div>
  );
}
