import { pipeline, env } from "@huggingface/transformers";
import wasmBinary from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import wasmMjs from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import type { VisualResult } from "./types";
import { withTimeout } from "./file";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = "https://huggingface.co/";
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: wasmMjs,
    wasm: wasmBinary,
  };
}

type Classifier = (input: HTMLCanvasElement) => Promise<Array<{ label: string; score: number }>>;
type PipelineFactory = (
  task: string,
  model: string,
  options?: { dtype?: string; revision?: string },
) => Promise<Classifier>;

type ScoreSet = { ai: number; real: number; hint: string | null };

const BINARY_MODEL = "onnx-community/SMOGY-Ai-images-detector-ONNX";
const SOURCE_MODEL = "onnx-community/ai-source-detector-ONNX";
const MODEL_REVISIONS: Record<string, string> = {
  [SOURCE_MODEL]: "9a1c4127b96f6b76e7674c01af2642bf248e5950",
};

let binaryPromise: Promise<Classifier> | null = null;
let sourcePromise: Promise<Classifier> | null = null;

function isRealLabel(label: string) {
  return /^(human|real|authentic|photo|natural)/i.test(label.trim());
}

function scoreOutput(output: Array<{ label: string; score: number }>): ScoreSet {
  let ai = 0;
  let real = 0;
  let hint: string | null = null;
  let hintScore = 0;
  for (const row of output) {
    if (isRealLabel(row.label)) {
      real += row.score;
    } else {
      ai += row.score;
      if (row.score > hintScore) {
        hintScore = row.score;
        hint = row.label.replaceAll("_", " ");
      }
    }
  }
  if (ai + real > 0) {
    const total = ai + real;
    ai /= total;
    real /= total;
  }
  return { ai, real, hint: hintScore >= 0.28 ? hint : null };
}

async function loadModel(model: string) {
  const create = pipeline as unknown as PipelineFactory;
  try {
    return await create("image-classification", model, { dtype: "q4", revision: MODEL_REVISIONS[model] });
  } catch {
    return await create("image-classification", model, { dtype: "q8", revision: MODEL_REVISIONS[model] });
  }
}

function getBinary() {
  if (!binaryPromise) {
    binaryPromise = loadModel(BINARY_MODEL).catch((error) => {
      binaryPromise = null;
      throw error;
    });
  }
  return binaryPromise;
}

function getSource() {
  if (!sourcePromise) {
    sourcePromise = loadModel(SOURCE_MODEL).catch((error) => {
      sourcePromise = null;
      throw error;
    });
  }
  return sourcePromise;
}

export function preloadVisualModel() {
  void getBinary().catch(() => {
    binaryPromise = null;
  });
  void getSource().catch(() => {
    sourcePromise = null;
  });
}

export function visualLoading(): VisualResult {
  return {
    ready: false,
    error: null,
    aiScore: 0,
    realScore: 0,
    label: "loading",
    evidence: [
      {
        label: "Visual classifier",
        detail: "Loading two on-device detectors. Credentials and metadata can score first.",
        pointsTo: "inconclusive",
      },
    ],
  };
}

function snapshotCanvas(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  const max = 768;
  const scale = Math.min(1, max / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare a preview for the visual model.");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function runClassifier(load: Promise<Classifier>, image: HTMLCanvasElement, label: string) {
  const classifier = await withTimeout(load, 90000, `${label} download`);
  const output = await withTimeout(classifier(image), 30000, `${label} inference`);
  return scoreOutput(output);
}

export async function analyzeVisual(image: HTMLImageElement): Promise<VisualResult> {
  try {
    const snapshot = snapshotCanvas(image);
    const results = await Promise.allSettled([
      runClassifier(getBinary(), snapshot, "Binary detector"),
      runClassifier(getSource(), snapshot, "Source detector"),
    ]);

    const binary = results[0].status === "fulfilled" ? results[0].value : null;
    const source = results[1].status === "fulfilled" ? results[1].value : null;
    if (!binary && !source) {
      const reason =
        results.find((r) => r.status === "rejected")?.reason ?? new Error("Both visual models failed.");
      throw reason instanceof Error ? reason : new Error(String(reason));
    }

    const binaryAi = binary?.ai ?? source?.ai ?? 0;
    const sourceAi = source?.ai ?? binaryAi;
    const agreed = Boolean(binary && source && binary.ai >= 0.3 && source.ai >= 0.3);
    const aiScore = agreed
      ? Math.max(binaryAi, sourceAi)
      : Math.max(binaryAi, 0.5 * binaryAi + 0.5 * sourceAi);
    const realScore = 1 - aiScore;
    const hint = source?.hint && source.ai >= 0.45 ? source.hint : binary?.hint;
    const pointsTo = aiScore >= 0.48 ? "ai" : aiScore <= 0.32 ? "authentic" : "inconclusive";
    const parts = [
      binary ? `binary ${(binary.ai * 100).toFixed(0)}%` : null,
      source ? `source ${(source.ai * 100).toFixed(0)}%` : null,
    ].filter(Boolean);

    return {
      ready: true,
      error: null,
      aiScore,
      realScore,
      label: hint ?? "unknown",
      evidence: [
        {
          label: hint && aiScore >= 0.4 ? `Looks like ${hint}` : "Visual ensemble",
          detail: `Combined on-device score — AI ${(aiScore * 100).toFixed(1)}% (${parts.join(", ")}). The binary detector is primary; the source detector can raise the score when both see synthesis.`,
          pointsTo,
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ready: false,
      error: message,
      aiScore: 0,
      realScore: 0,
      label: "unavailable",
      evidence: [
        {
          label: "Visual classifier unavailable",
          detail: `The local models could not run (${message}). Content Credentials and metadata are still used.`,
          pointsTo: "inconclusive",
        },
      ],
    };
  }
}
