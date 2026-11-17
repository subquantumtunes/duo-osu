/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/osu-coop-bridge.py',
        headers: [
          { key: 'Content-Type', value: 'text/x-python; charset=utf-8' },
          { key: 'Content-Disposition', value: 'attachment; filename="osu-coop-bridge.py"' },
        ],
      },
    ]
  },
}

export default nextConfig
