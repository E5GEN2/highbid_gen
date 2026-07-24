import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  instrumentationHook: true,
  serverExternalPackages: ['@remotion/renderer', '@remotion/bundler', 'playwright', 'playwright-core', 'franc'],
  experimental: {
    serverActions: {
      bodySizeLimit: '500MB'
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
  // MCP connector OAuth discovery — map the RFC 9728 / RFC 8414 well-known
  // paths (which Next's app router can't serve from a dot-folder) onto real
  // API routes. Both root and path-scoped variants (clients probe either).
  async rewrites() {
    return [
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/authorization-server' },
      { source: '/.well-known/oauth-authorization-server/api/mcp', destination: '/api/oauth/authorization-server' },
    ];
  },
};

export default nextConfig;
