import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These packages must run as plain Node modules on the server (not bundled).
  serverExternalPackages: ["@react-pdf/renderer", "exceljs", "unpdf", "postgres"],
  // Files read from disk at runtime (settings, branding images, seed prices) must ship with the serverless functions.
  outputFileTracingIncludes: { "/api/**": ["./config/**", "./data/seed.json"] },
};

export default nextConfig;
