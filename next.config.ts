import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@remotion/renderer', '@remotion/bundler'],
  experimental: {
    serverActions: {
      bodySizeLimit: '50MB'
    }
  },
  eslint: {
    // Warning: This allows production builds to successfully complete even if
    // your project has ESLint errors.
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'img.youtube.com',
      },
    ],
  },
};

export default nextConfig;
