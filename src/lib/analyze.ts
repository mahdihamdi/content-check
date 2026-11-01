import { analyzeC2pa, failedC2pa } from "./c2pa";
import { assertSafeDimensions, mimeForKind, validateImageFile } from "./guard";
import { analyzeMetadata } from "./metadata";
import { analyzeVisual, visualLoading } from "./visual";
import { buildVerdict } from "./verdict";
import type { AnalysisResult } from "./types";

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read this image. Try JPEG or PNG."));
    img.src = url;
  });
}

export async function analyzeFile(
  file: File,
  previewUrl: string,
  onPartial: (result: AnalysisResult) => boolean,
): Promise<void> {
  const kind = await validateImageFile(file);
  const image = await loadImage(previewUrl);
  assertSafeDimensions(image.naturalWidth, image.naturalHeight);
  const [c2pa, metadata] = await Promise.all([
    analyzeC2pa(file, mimeForKind(kind)).catch((err) =>
      failedC2pa(err instanceof Error ? err.message : "Content Credentials could not be read."),
    ),
    analyzeMetadata(file, image),
  ]);

  if (!onPartial(buildVerdict(file, previewUrl, c2pa, metadata, visualLoading()))) return;

  const visual = await analyzeVisual(image);
  onPartial(buildVerdict(file, previewUrl, c2pa, metadata, visual));
}
