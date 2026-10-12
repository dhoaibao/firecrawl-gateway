#!/bin/sh
# Runs from /docker-entrypoint.d at container start. Copies the built site to /tmp/site and
# replaces the __PORTAL_URL__ placeholder with LANDING_PORTAL_URL (the portal's origin,
# e.g. https://app.example.com), so one image serves every environment.
set -eu

url="${LANDING_PORTAL_URL:-}"
url="${url%/}"

if [ -n "$url" ]; then
  case "$url" in
    http://* | https://*) ;;
    *)
      echo "LANDING_PORTAL_URL must start with http:// or https://" >&2
      exit 1
      ;;
  esac
  # The value is spliced into HTML attributes and a sed expression: URL characters only.
  if printf '%s' "$url" | grep -q '[^A-Za-z0-9:/._-]'; then
    echo "LANDING_PORTAL_URL contains unsupported characters" >&2
    exit 1
  fi
else
  # Without a portal address the sign-in links point at the site root.
  url="/"
fi

rm -rf /tmp/site
cp -R /usr/share/nginx/dist /tmp/site
find /tmp/site -name '*.html' -exec sed -i "s|__PORTAL_URL__|$url|g" {} +
