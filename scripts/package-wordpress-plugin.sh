#!/usr/bin/env bash
# Zips integrations/wordpress/kalendr-booking into dist/kalendr-booking.zip, ready for Plugins > Add New > Upload.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/dist"
rm -f "$root/dist/kalendr-booking.zip"
(cd "$root/integrations/wordpress" && zip -rq "$root/dist/kalendr-booking.zip" kalendr-booking -x '*.DS_Store')
echo "Wrote dist/kalendr-booking.zip"
