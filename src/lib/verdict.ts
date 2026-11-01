import { sanitizeDisplay } from "./guard";
import type { AnalysisResult, C2paResult, Likelihood, MetadataResult, VisualResult } from "./types";

function clamp(n: number) {
  return Math.max(0.05, Math.min(0.99, n));
}

export function buildVerdict(
  file: File,
  previewUrl: string,
  c2pa: C2paResult,
  metadata: MetadataResult,
  visual: VisualResult,
): AnalysisResult {
  let verdict: Likelihood = "inconclusive";
  let confidence = 0.42;
  let headline = "Not enough to decide";
  let summary =
    "No signed Content Credentials and no strong generator tags. Visual scores alone are not treated as proof that an image is real.";

  const visualAi = visual.ready && visual.aiScore >= 0.48;
  const visualLeanAi = visual.ready && visual.aiScore >= 0.34;
  const cameraSupport = metadata.hasCameraTags || metadata.gps;

  if (c2pa.present && c2pa.generative) {
    verdict = "ai";
    confidence = c2pa.valid ? 0.97 : 0.82;
    headline = "Content Credentials mark this as AI-generated";
    summary = c2pa.generator
      ? `The attached C2PA manifest reports generative media from ${c2pa.generator}. Signed credentials outweigh visual guesses.`
      : "The attached C2PA manifest reports trained algorithmic / generative media.";
  } else if (metadata.aiTool || metadata.xmpGenerative) {
    verdict = "ai";
    confidence = 0.88;
    headline = metadata.aiTool ? `Metadata points to ${metadata.aiTool}` : "XMP marks this as generative";
    summary =
      "Generator tags or an IPTC digital source type are in the file. Those can be stripped, but when present they outweigh a 'real' visual score.";
  } else if (visualAi) {
    verdict = "ai";
    confidence = clamp(0.58 + (visual.aiScore - 0.48) * 0.9);
    headline = visual.label && visual.aiScore >= 0.45 ? `Visual detectors lean ${visual.label}` : "Visual analysis leans AI-generated";
    summary =
      "Two on-device classifiers were combined using the higher AI probability so newer generators are less likely to be called authentic.";
  } else if (visualLeanAi && metadata.generatorCanvas && !cameraSupport) {
    verdict = "ai";
    confidence = clamp(0.52 + visual.aiScore * 0.25);
    headline = "Canvas size and visual score both suggest AI";
    summary = `${metadata.width}×${metadata.height} is a common generator export, and the visual ensemble is not confident this is a photograph.`;
  } else if (c2pa.present && c2pa.cameraCapture) {
    verdict = "authentic";
    confidence = c2pa.valid ? 0.93 : 0.78;
    headline = "Content Credentials mark this as captured media";
    summary =
      "A C2PA manifest reports a digital capture source. Later edits can still exist in the provenance chain.";
  } else if (cameraSupport && visual.ready && visual.aiScore < 0.32 && !metadata.generatorCanvas) {
    verdict = "authentic";
    confidence = clamp(0.6 + (0.32 - visual.aiScore) * 0.5);
    headline = "Looks like a photograph";
    summary = "Camera metadata is present and the visual ensemble does not see synthesis artifacts. This is still not a cryptographic guarantee.";
  } else if (c2pa.present) {
    headline = "Credentials found, origin mixed or unspecified";
    summary = "A C2PA manifest is present but does not clearly label generative vs captured media.";
    confidence = 0.5;
  } else if (visual.ready && visual.aiScore >= 0.28) {
    headline = "Possible AI, not enough to confirm";
    summary =
      "The visual ensemble is mixed and there is no camera provenance. Treat this as uncertain rather than authentic.";
    confidence = 0.46;
  }

  if (verdict === "ai" && visual.ready && visual.realScore > 0.7) {
    summary += " One detector leaned real; provenance or the higher AI score still governs.";
  }

  return {
    fileName: sanitizeDisplay(file.name, 120) || "image",
    fileSize: file.size,
    previewUrl,
    c2pa,
    metadata,
    visual,
    verdict,
    confidence,
    headline,
    summary,
  };
}
