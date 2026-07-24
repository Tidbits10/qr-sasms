/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // File uploads (ID/OR photos, attachments, forms) are written to /public/uploads
  // and served statically by Next.js — no extra config needed for that.
  experimental: {
    serverActions: {
      bodySizeLimit: '5mb',
    },
  },
};

module.exports = nextConfig;
