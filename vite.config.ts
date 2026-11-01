import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function contentSecurityPolicy(dev: boolean) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Dev needs the inline React refresh preamble. Preview stays stricter.
    `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ""}`,
    "worker-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.cdn.hf.co https://*.aws.cdn.hf.co ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  ].join("; ");
}

const securityHeaders = {
  "Content-Security-Policy": contentSecurityPolicy(true),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: securityHeaders },
  preview: {
    headers: {
      ...securityHeaders,
      "Content-Security-Policy": contentSecurityPolicy(false),
    },
  },
  optimizeDeps: {
    exclude: ["@contentauth/c2pa-web"],
  },
  assetsInclude: ["**/*.wasm"],
});
