#!/bin/sh
exec node "$(dirname "$0")/setup-clients.mjs" "$@"
