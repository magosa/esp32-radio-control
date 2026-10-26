/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 旧URLを目的別の新URLへ互換する（ブラウザーに永続キャッシュさせない一時リダイレクト）。
  async redirects() {
    return [
      { source: "/fleet", destination: "/control", permanent: false },
      { source: "/fleet/settings", destination: "/settings", permanent: false },
      { source: "/bluetooth", destination: "/direct/bluetooth", permanent: false },
      { source: "/api/fleet/routes", destination: "/api/routes", permanent: false },
    ];
  },
};

export default nextConfig;
