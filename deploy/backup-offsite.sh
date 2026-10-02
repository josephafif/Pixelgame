#!/bin/sh
# Copies the server's daily backups somewhere else (run from cron once a day):
#   0 5 * * * /home/ubuntu/Pixelgame/deploy/backup-offsite.sh
# Needs rclone with a remote named "backup" (Cloudflare R2, Oracle Object
# Storage, Google Drive …):  rclone config
set -eu
cd "$(dirname "$0")/.."
rclone copy server-data/backups backup:pixelgame-backups --max-age 48h
