import type { NextConfig } from "next";
import { execSync } from "child_process";

function getBuildInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD').toString().trim();
    const date = new Date(execSync('git log -1 --format=%cI').toString().trim())
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    return { hash, date };
  } catch {
    return { hash: 'unknown', date: 'unknown' };
  }
}

const { hash, date } = getBuildInfo();

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: 'standalone',
  env: {
    NEXT_PUBLIC_BUILD_HASH: hash,
    NEXT_PUBLIC_BUILD_DATE: date,
  },
};

export default nextConfig;
