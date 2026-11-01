# Content Check

Browser app that estimates whether an image is AI-generated.

It combines:

1. **Content Credentials (C2PA)** — cryptographic provenance when a generator or camera embedded a manifest
2. **Metadata** — EXIF, XMP, and PNG text left by Firefly, Midjourney, DALL·E, Stable Diffusion, and others
3. **On-device visual classifiers** — binary and source detectors via Transformers.js

Image bytes stay in the browser. The visual models are downloaded from Hugging Face and run locally; images are not uploaded. Files over 15 MB, images over 8192 pixels on a side, and anything that is not a JPEG, PNG, WebP, GIF, TIFF, or AVIF are rejected before analysis.

## Run

```bash
npm install
npm run dev
```
