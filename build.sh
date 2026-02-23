#!/bin/bash
set -e

export NEXT_PUBLIC_BUILD_HASH=$(git rev-parse --short HEAD)
export NEXT_PUBLIC_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "Building: $NEXT_PUBLIC_BUILD_HASH • $NEXT_PUBLIC_BUILD_DATE"

docker compose up -d --build
