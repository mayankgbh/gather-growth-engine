const pkg = require("./package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || pkg.version,
  },
  async headers() {
    // Keep account and workspace screens usable without indexing them.
    return [
      "/login/:path*", "/signup/:path*", "/forgot-password/:path*",
      "/reset-password/:path*", "/verify-email/:path*",
      "/verify-email-pending/:path*", "/dashboard/:path*",
      "/onboarding/:path*", "/admin/:path*",
    ].map(source => ({
      source,
      headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
    }));
  },
  // Increase body size limit for large CSV uploads (default 4.5MB is too small for 2000-row files)
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  webpack: (config, { dev }) => {
    if (!dev) {
      config.optimization.minimize = false;
    }
    return config;
  },
};

module.exports = nextConfig;
