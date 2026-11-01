import { createC2pa, Reader } from "@contentauth/c2pa-web";
import wasmSrc from "@contentauth/c2pa-web/resources/c2pa.wasm?url";
import type { C2paResult, EvidenceItem } from "./types";
import { sanitizeDisplay } from "./guard";
import { withTimeout } from "./file";

type C2paSdk = Awaited<ReturnType<typeof createC2pa>>;

let sdkPromise: Promise<C2paSdk> | null = null;

const GEN_SOURCE = [
  "trainedalgorithmicmedia",
  "compositewithtrainedalgorithmicmedia",
  "algorithmicmedia",
];

const CAMERA_SOURCE = [
  "digitalcapture",
  "capturedwithc2pa",
  "negativefilm",
  "positivefilm",
  "print",
];

function wasmUrl() {
  try {
    return new URL(wasmSrc, window.location.href).href;
  } catch {
    return wasmSrc;
  }
}

function getSdk() {
  if (!sdkPromise) {
    sdkPromise = createC2pa({ wasmSrc: wasmUrl() }).catch((error) => {
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function collectStrings(value: unknown, keys: string[]): string[] {
  const acc: string[] = [];
  const seen = new Set<unknown>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0 && nodes < 4000 && acc.length < 48) {
    const current = stack.pop();
    if (!current || current.depth > 8) continue;
    nodes += 1;
    const { value: item, depth } = current;
    if (Array.isArray(item)) {
      if (seen.has(item)) continue;
      seen.add(item);
      for (let i = item.length - 1; i >= 0; i -= 1) stack.push({ value: item[i], depth: depth + 1 });
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    if (seen.has(rec)) continue;
    seen.add(rec);
    for (const [key, nested] of Object.entries(rec)) {
      const needle = key.toLowerCase();
      if (keys.includes(needle) && (typeof nested === "string" || typeof nested === "number")) {
        acc.push(sanitizeDisplay(String(nested), 180));
      } else if (nested && typeof nested === "object") {
        stack.push({ value: nested, depth: depth + 1 });
      }
    }
  }
  return acc;
}

function boundedHaystack(value: unknown): string {
  const parts: string[] = [];
  let budget = 60_000;
  const seen = new Set<unknown>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0 && nodes < 4000 && budget > 0) {
    const current = stack.pop();
    if (!current || current.depth > 8) continue;
    nodes += 1;
    const item = current.value;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      const text = String(item).slice(0, 240);
      parts.push(text);
      budget -= text.length;
      continue;
    }
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const children = Array.isArray(item) ? item : Object.values(item);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ value: children[i], depth: current.depth + 1 });
    }
  }
  return parts.join(" ").toLowerCase();
}

function unique(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function looksGenerative(text: string) {
  const t = text.toLowerCase();
  return GEN_SOURCE.some((s) => t.includes(s)) || /generat|firefly|dall-?e|sora|imagen|midjourney|stable diffusion|flux/.test(t);
}

function looksCamera(text: string) {
  const t = text.toLowerCase();
  return CAMERA_SOURCE.some((s) => t.includes(s));
}

export function failedC2pa(message: string): C2paResult {
  return {
    present: false,
    valid: false,
    generator: null,
    producer: null,
    title: null,
    digitalSourceTypes: [],
    softwareAgents: [],
    actions: [],
    generative: false,
    cameraCapture: false,
    issues: [message],
    evidence: [
      {
        label: "Content Credentials failed",
        detail: message,
        pointsTo: "inconclusive",
      },
    ],
  };
}

function emptyC2pa(issues: string[] = []): C2paResult {
  return {
    present: false,
    valid: false,
    generator: null,
    producer: null,
    title: null,
    digitalSourceTypes: [],
    softwareAgents: [],
    actions: [],
    generative: false,
    cameraCapture: false,
    issues,
    evidence: [
      {
        label: "No Content Credentials",
        detail:
          "This file does not include a C2PA Content Credentials manifest, or it was stripped. Missing credentials is not proof that an image is real.",
        pointsTo: "inconclusive",
      },
    ],
  };
}

export async function analyzeC2pa(file: File, format: string): Promise<C2paResult> {
  let reader: Awaited<ReturnType<typeof Reader.fromBlob>> = null;

  try {
    const c2pa = await withTimeout(getSdk(), 20000, "Content Credentials engine");
    reader = await withTimeout(Reader.fromBlob(c2pa, format, file), 20000, "Content Credentials read");
    if (!reader) return emptyC2pa();
    const store = await reader.manifestStore();
    if (!store) return emptyC2pa();

    const rec = asRecord(store);
    if (!rec || Object.keys(rec).length === 0) return emptyC2pa();
    const haystack = boundedHaystack(store);

    const manifests = asRecord(rec.manifests) ?? asRecord(rec.Manifests);
    const hasManifests = manifests && Object.keys(manifests).length > 0;
    if (!hasManifests && !rec.active_manifest && !rec.activeManifest) {
      return emptyC2pa();
    }

    const sourceTypes = unique(
      collectStrings(store, ["digitalsourcetype", "digital_source_type", "digitalSourceType"]),
    );
    const softwareAgents = unique(
      collectStrings(store, ["softwareagent", "software_agent", "softwareAgent"]),
    );
    const actions = unique(collectStrings(store, ["action"]));
    const generators = unique(
      collectStrings(store, ["claim_generator", "claimgenerator", "claimGenerator", "generator"]),
    );
    const titles = unique(collectStrings(store, ["title"]));
    const producers = unique(collectStrings(store, ["name", "producer"]));

    const generative =
      sourceTypes.some(looksGenerative) ||
      softwareAgents.some(looksGenerative) ||
      generators.some(looksGenerative) ||
      /trainedalgorithmicmedia|compositewithtrainedalgorithmicmedia/.test(haystack);

    const cameraCapture =
      sourceTypes.some(looksCamera) ||
      /digitalcapture|capturedwithc2pa/.test(haystack);

    const validation = collectStrings(store, ["explanation", "code", "description"]).filter((v) =>
      /error|fail|invalid|mismatch/i.test(v),
    );

    const evidence: EvidenceItem[] = [];
    if (generative) {
      evidence.push({
        label: "Signed as generative AI",
        detail:
          sourceTypes.find(looksGenerative) ??
          softwareAgents[0] ??
          "The Content Credentials manifest reports trained algorithmic / generative media.",
        pointsTo: "ai",
      });
    } else if (cameraCapture) {
      evidence.push({
        label: "Signed as captured media",
        detail:
          sourceTypes.find(looksCamera) ??
          "The Content Credentials manifest reports a digital capture source type.",
        pointsTo: "authentic",
      });
    } else {
      evidence.push({
        label: "Content Credentials found",
        detail: "A C2PA manifest is attached. Review generator and actions below.",
        pointsTo: "inconclusive",
      });
    }

    if (generators[0]) {
      evidence.push({
        label: "Claim generator",
        detail: generators[0],
        pointsTo: looksGenerative(generators[0]) ? "ai" : "inconclusive",
      });
    }

    return {
      present: true,
      valid: validation.length === 0,
      generator: generators[0] ?? null,
      producer: producers.find((p) => p.length > 2 && p.length < 80) ?? null,
      title: titles[0] ?? null,
      digitalSourceTypes: sourceTypes,
      softwareAgents,
      actions: actions.slice(0, 12),
      generative,
      cameraCapture: cameraCapture && !generative,
      issues: validation.slice(0, 6),
      evidence,
    };
  } catch (error) {
    const message = sanitizeDisplay(
      error instanceof Error ? error.message : "Content Credentials could not be read.",
      180,
    );
    if (/no claim|not found|no jumbf|missing/i.test(message)) {
      return emptyC2pa();
    }
    return emptyC2pa([message]);
  } finally {
    try {
      await reader?.free?.();
    } catch {
      /* ignore */
    }
  }
}
