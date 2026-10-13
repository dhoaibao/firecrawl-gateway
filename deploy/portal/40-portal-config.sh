#!/bin/sh
# Runs from /docker-entrypoint.d at container start. Writes /tmp/portal-config.js,
# which the SPA loads before it starts, so the same image works in every environment.
#
# PORTAL_API_BASE_URL is the origin of the gateway API, e.g. https://api.example.com.
# Empty means the API shares the portal's origin.
set -eu

base="${PORTAL_API_BASE_URL:-}"
base="${base%/}"

if [ -n "$base" ]; then
  case "$base" in
    http://* | https://*) ;;
    *)
      echo "PORTAL_API_BASE_URL must start with http:// or https://" >&2
      exit 1
      ;;
  esac
  # An origin only: the value is written into a script, so nothing but URL characters.
  if printf '%s' "$base" | grep -q '[^A-Za-z0-9:/._-]'; then
    echo "PORTAL_API_BASE_URL contains unsupported characters" >&2
    exit 1
  fi
fi

printf 'window.__PORTAL_CONFIG__={"apiBaseUrl":"%s"};\n' "$base" > /tmp/portal-config.js
