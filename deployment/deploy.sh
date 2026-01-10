#!/bin/bash

# TRMNL Bitcoin Price Deployment Script
# This script is triggered by n8n webhook when code is pushed to Codeberg

set -e  # Exit on error

DEPLOY_DIR="/home/antfarm/deployments/trmnl-btcprice"
REPO_URL="https://codeberg.org/YOUR_USERNAME/trmnl-btcprice.git"
SERVICE_NAME="trmnl-btcprice"

echo "=== Starting TRMNL Bitcoin Price Deployment ==="
echo "Timestamp: $(date)"

# Navigate to deployment directory
cd "$DEPLOY_DIR" || exit 1

# Pull latest code from Codeberg
echo "Pulling latest code from Codeberg..."
if [ -d ".git" ]; then
    git fetch origin
    git reset --hard origin/main
    git clean -fd
else
    echo "Git repository not initialized. Cloning..."
    cd /home/antfarm/deployments/
    rm -rf trmnl-btcprice
    git clone "$REPO_URL" trmnl-btcprice
    cd trmnl-btcprice
fi

# Install dependencies
echo "Installing dependencies..."
npm ci --production

# Restart the service
echo "Restarting service..."
sudo systemctl restart "$SERVICE_NAME"

# Check service status
sleep 3
if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "✓ Deployment successful! Service is running."
    sudo systemctl status "$SERVICE_NAME" --no-pager
else
    echo "✗ Deployment failed! Service is not running."
    sudo systemctl status "$SERVICE_NAME" --no-pager
    exit 1
fi

echo "=== Deployment Complete ==="
