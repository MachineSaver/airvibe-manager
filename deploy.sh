#!/bin/bash
set -e

# deploy.sh — fast VPS deployment using pre-built images from ghcr.io.
#
# GitHub Actions builds and pushes images on every push to main (tag: latest)
# and on pushes to other tracked branches (tag: branch name).
# This script just pulls the images and restarts affected containers.
# No compiler or build tools required on the VPS — completes in seconds.
#
# Usage:
#   ./deploy.sh                        # pulls :latest (main branch)
#   IMAGE_TAG=ui-redesign ./deploy.sh  # pulls :ui-redesign branch image
#
# Use ./build.sh instead if you need to build images locally (e.g. local dev,
# or if you have not yet set up the NEXT_PUBLIC_API_URL GitHub Actions secret).

export IMAGE_TAG="${IMAGE_TAG:-latest}"

git pull

docker compose pull frontend backend

docker compose up -d

echo ""
echo "Deployed (IMAGE_TAG=${IMAGE_TAG}):"
docker images --format "  {{.Repository}}:{{.Tag}}: {{.CreatedAt}}" | grep airvibe-manager-
