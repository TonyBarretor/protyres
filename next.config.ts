import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These packages must run as plain Node modules on the server (not bundled).
  serverExternalPackages: ["@react-pdf/renderer", "exceljs", "unpdf", "postgres"],
  // Files read from disk at runtime (settings, branding images, seed prices) must ship with the serverless functions.
  outputFileTracingIncludes: { "/api/**": ["./config/**", "./data/seed.json.gz"], "/portal/**": ["./config/**"] },
  // "Subir ventas" sends the .xlsx through a server action (default limit 1 MB). Vercel rejects bodies over 4.5 MB anyway;
  // the form caps files at 4 MB (src/app/portal/ventas/types.ts).
  experimental: { serverActions: { bodySizeLimit: "4.5mb" } },
};

export default nextConfig;
