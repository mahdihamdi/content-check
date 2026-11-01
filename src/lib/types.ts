export type Likelihood = "ai" | "authentic" | "inconclusive";

export type SignalStrength = "high" | "medium" | "low";

export type EvidenceItem = {
  label: string;
  detail: string;
  pointsTo: Likelihood;
};

export type C2paResult = {
  present: boolean;
  valid: boolean;
  generator: string | null;
  producer: string | null;
  title: string | null;
  digitalSourceTypes: string[];
  softwareAgents: string[];
  actions: string[];
  generative: boolean;
  cameraCapture: boolean;
  issues: string[];
  evidence: EvidenceItem[];
};

export type MetadataResult = {
  format: string;
  width: number | null;
  height: number | null;
  make: string | null;
  model: string | null;
  software: string | null;
  datetime: string | null;
  gps: boolean;
  aiTool: string | null;
  xmpGenerative: boolean;
  generatorCanvas: boolean;
  hasCameraTags: boolean;
  notes: string[];
  evidence: EvidenceItem[];
};

export type VisualResult = {
  ready: boolean;
  error: string | null;
  aiScore: number;
  realScore: number;
  label: string;
  evidence: EvidenceItem[];
};

export type AnalysisResult = {
  fileName: string;
  fileSize: number;
  previewUrl: string;
  c2pa: C2paResult;
  metadata: MetadataResult;
  visual: VisualResult;
  verdict: Likelihood;
  confidence: number;
  headline: string;
  summary: string;
};

export type JobStatus = "queued" | "running" | "done" | "error";

export type AnalysisJob = {
  id: string;
  file: File;
  fileName: string;
  fileSize: number;
  previewUrl: string;
  status: JobStatus;
  error: string | null;
  result: AnalysisResult | null;
};
