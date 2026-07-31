#!/bin/sh
set -eu

# Named volumes retain ownership across image upgrades. Older gateway images ran
# as root, so repair the audit volume before dropping privileges.
mkdir -p /data
chown -R gateway:gateway /data

exec su -s /bin/sh gateway -c 'exec "$0" "$@"' "$@"
