#!/bin/bash
set -e

# deploy.sh — fast VPS deployment using pre-built images from ghcr.io.
#
# GitHub Actions builds and pushes images on every push to main.
# This script just pulls the latest images and restarts affected containers.
# No compiler or build tools required on the VPS — completes in seconds.
#
# Use ./build.sh instead if you need to build images locally (e.g. local dev,
# or if you have not yet set up the NEXT_PUBLIC_API_URL GitHub Actions secret).

git pull

docker compose pull frontend backend

docker compose up -d

echo ""
echo "Deployed:"
docker images --format "  {{.Repository}}: {{.CreatedAt}}" | grep airvibe-manager-
