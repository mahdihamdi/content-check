import exifr from "exifr";
import { sanitizeDisplay } from "./guard";
import { withTimeout } from "./file";
import type { EvidenceItem, MetadataResult } from "./types";

const AI_TOOLS: { pattern: RegExp; name: string }[] = [
  { pattern: /midjourney/i, name: "Midjourney" },
  { pattern: /dall-?e|gpt-image|chatgpt image/i, name: "OpenAI image" },
  { pattern: /chatgpt|openai/i, name: "OpenAI" },
  { pattern: /adobe firefly|firefly|generative fill/i, name: "Adobe Firefly" },
  { pattern: /stable diffusion|automatic1111|a1111|comfyui|invokeai|fooocus/i, name: "Stable Diffusion" },
  { pattern: /flux(\.1)?|black forest labs/i, name: "FLUX" },
  { pattern: /leonardo(\.ai)?/i, name: "Leonardo" },
  { pattern: /ideogram/i, name: "Ideogram" },
  { pattern: /runway/i, name: "Runway" },
  { pattern: /nightcafe/i, name: "NightCafe" },
  { pattern: /novelai/i, name: "NovelAI" },
  { pattern: /civitai|tensor\.art|seaart/i, name: "Civitai" },
  { pattern: /imagefx|imagen|gemini|nanobanana/i, name: "Google Imagen" },
  { pattern: /sora/i, name: "Sora" },
  { pattern: /bing image creator/i, name: "Bing Image Creator" },
  { pattern: /\bgrok\b|xai/i, name: "Grok" },
  { pattern: /recraft|krea|higgsfield|luma|pika|runwayml/i, name: "AI video/image tool" },
];

const GEN_SIZES: Array<[number, number]> = [
  [512, 512],
  [640, 640],
  [768, 768],
  [832, 1216],
  [896, 896],
  [896, 1152],
  [1024, 1024],
  [1024, 768],
  [1024, 1792],
  [1152, 896],
  [1216, 832],
  [1248, 832],
  [1280, 1280],
  [1344, 768],
  [1408, 768],
  [1456, 816],
  [1536, 1536],
  [1632, 672],
  [1792, 1024],
  [2048, 2048],
];

function flatten(value: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 6 || value == null || acc.length > 400) return acc;
  if (typeof value === "string" || typeof value === "number") {
    acc.push(String(value));
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, acc, depth + 1);
    return acc;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      flatten(nested, acc, depth + 1);
    }
  }
  return acc;
}

function sanitizeField(value: unknown): string | null {
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = sanitizeDisplay(String(raw), 160);
  return text || null;
}

function detectTool(haystack: string) {
  for (const tool of AI_TOOLS) {
    if (tool.pattern.test(haystack)) return tool.name;
  }
  return null;
}

function looksGenerativeXmp(haystack: string) {
  return /trainedalgorithmicmedia|compositewithtrainedalgorithmicmedia|algorithmicmedia|syntheticallygenerated|digitalSourceType.*generat/i.test(
    haystack,
  );
}

function isGeneratorCanvas(width: number, height: number) {
  const pair = width <= height ? [width, height] : [height, width];
  return GEN_SIZES.some(([a, b]) => {
    const [w, h] = a <= b ? [a, b] : [b, a];
    return Math.abs(pair[0] - w) <= 4 && Math.abs(pair[1] - h) <= 4;
  });
}

async function readPngText(file: File): Promise<string> {
  const mime = file.type || "";
  if (!mime.includes("png") && !file.name.toLowerCase().endsWith(".png")) return "";
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (pngSig.some((b, i) => bytes[i] !== b)) return "";

  const decoder = new TextDecoder("latin1");
  let text = "";
  let offset = 8;
  let chunks = 0;
  while (offset + 8 < bytes.length && chunks < 2000 && text.length < 200_000) {
    chunks += 1;
    const length = new DataView(buffer).getUint32(offset);
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    const start = offset + 8;
    if (length > bytes.length || start > bytes.length - length) break;
    const end = start + length;
    if ((type === "tEXt" || type === "iTXt" || type === "zTXt") && length <= 1_000_000) {
      const piece = decoder.decode(bytes.slice(start, end));
      text += piece.slice(0, 200_000 - text.length);
    }
    offset = end + 4;
    if (type === "IEND") break;
  }
  return text;
}

export async function analyzeMetadata(file: File, image: HTMLImageElement): Promise<MetadataResult> {
  const notes: string[] = [];
  const evidence: EvidenceItem[] = [];

  let parsed: Record<string, unknown> = {};
  try {
    parsed =
      (await withTimeout(
        exifr.parse(file, {
          tiff: true,
          xmp: true,
          icc: false,
          iptc: true,
          jfif: true,
          ihdr: true,
          mergeOutput: true,
        }),
        10000,
        "Metadata read",
      )) ?? {};
  } catch {
    notes.push("Could not parse EXIF/XMP from this file.");
  }

  const pngText = await readPngText(file);
  const blob = flatten(parsed).concat(pngText);
  const haystack = blob.join("\n");
  const xmpGenerative = looksGenerativeXmp(haystack);
  const aiTool =
    detectTool(haystack) ||
    detectTool(`${file.name}\n${pngText}`) ||
    (xmpGenerative ? "Generative XMP" : null);
  const generatorCanvas = isGeneratorCanvas(image.naturalWidth, image.naturalHeight);

  const software = sanitizeField(parsed.Software) || sanitizeField(parsed.CreatorTool) || sanitizeField(parsed.creatorTool);
  const make = sanitizeField(parsed.Make);
  const model = sanitizeField(parsed.Model);
  const datetime =
    sanitizeField(parsed.DateTimeOriginal) || sanitizeField(parsed.CreateDate) || sanitizeField(parsed.ModifyDate);
  const gps = Boolean(parsed.latitude || parsed.GPSLatitude);

  if (aiTool) {
    evidence.push({
      label: "Generator identified in metadata",
      detail: `${aiTool} appears in EXIF, XMP, or PNG text chunks.`,
      pointsTo: "ai",
    });
  }

  if (pngText.toLowerCase().includes("parameters") || /steps:\s*\d+.*cfg scale/i.test(pngText)) {
    evidence.push({
      label: "Stable Diffusion parameters",
      detail: "PNG text includes generation parameters typically written by Automatic1111 or ComfyUI.",
      pointsTo: "ai",
    });
  }

  if (xmpGenerative && !evidence.some((item) => item.pointsTo === "ai")) {
    evidence.push({
      label: "XMP marks generative media",
      detail: "IPTC/XMP digital source type reports trained or composite algorithmic media.",
      pointsTo: "ai",
    });
  }

  const hasCameraTags = Boolean((make || model) && !detectTool([make, model, software].filter(Boolean).join(" ")));
  if (hasCameraTags) {
    evidence.push({
      label: "Camera tags present",
      detail: [make, model].filter(Boolean).join(" "),
      pointsTo: "authentic",
    });
  }

  if (generatorCanvas && !hasCameraTags) {
    evidence.push({
      label: "Typical generator canvas",
      detail: `${image.naturalWidth}×${image.naturalHeight} matches common AI export sizes, with no camera EXIF.`,
      pointsTo: "ai",
    });
  }

  if (gps) {
    evidence.push({
      label: "GPS coordinates",
      detail: "Embedded location data is more common on captured photos than generated images.",
      pointsTo: "authentic",
    });
  }

  if (software && !aiTool) {
    notes.push(`Software: ${software}`);
  }

  if (!evidence.length) {
    evidence.push({
      label: "Limited metadata",
      detail:
        "No camera EXIF and no generator tags were found. Many AI tools strip metadata; many phones keep it.",
      pointsTo: "inconclusive",
    });
  }

  return {
    format: file.type || "unknown",
    width: image.naturalWidth || null,
    height: image.naturalHeight || null,
    make,
    model,
    software,
    datetime,
    gps,
    aiTool,
    xmpGenerative,
    generatorCanvas,
    hasCameraTags,
    notes,
    evidence,
  };
}
