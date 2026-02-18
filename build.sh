#!/bin/bash
set -e

export NEXT_PUBLIC_BUILD_HASH=$(git rev-parse --short HEAD)
export NEXT_PUBLIC_BUILD_DATE=$(git log -1 --format=%cI | sed 's/+00:00$/Z/')

echo "Building: $NEXT_PUBLIC_BUILD_HASH • $NEXT_PUBLIC_BUILD_DATE UTC"

docker compose up -d --build
