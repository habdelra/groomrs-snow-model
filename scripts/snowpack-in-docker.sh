#!/usr/bin/env bash
# Runs the SNOWPACK binary from the snow-model image, for host-side
# development (`mise run dev`) where SNOWPACK isn't installed. Mounts DATA_DIR
# at the same path so the absolute paths in a run's io.ini resolve, and runs
# as the host user so outputs stay writable.
set -euo pipefail
: "${DATA_DIR:?DATA_DIR must be set}"
mkdir -p "$DATA_DIR"
exec docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  -v "$DATA_DIR:$DATA_DIR" \
  -w "$(pwd -P)" \
  --entrypoint snowpack \
  "${SNOW_MODEL_IMAGE:-groomrs-snow-model-snow-model}" "$@"
