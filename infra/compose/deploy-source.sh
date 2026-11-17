#!/usr/bin/env bash
# Deploys a revision by building it on this host and running the app from that build
# (docker-compose.source.yml), so nothing is published to or pulled from a registry. Postgres,
# the data volume and the computer image stay as docker-compose.images.yml sets them up.
#
# Usage: deploy-source.sh [revision]   (default: origin/main; an earlier one rolls back)
#
# Each release is a clean export of the revision under $RAKAZO_SOURCE_ROOT/releases, built in
# the same Node image it runs in. The pnpm store sits beside the releases so installs hard-link
# instead of downloading, and `current` points at the release that runs. A forced SSH command
# can run this from memory: script="$(git -C <repo> show <rev>:infra/compose/deploy-source.sh)".
set -Eeuo pipefail

APP_DIR="${RAKAZO_APP_DIR:-$HOME/rakazo}"
REPO="${RAKAZO_SOURCE_REPO:-$HOME/rakazo-src}"
ROOT="${RAKAZO_SOURCE_ROOT:-$HOME/rakazo-native}"
BACKUPS="${RAKAZO_BACKUP_DIR:-$HOME/rakazo-backups}"
NODE_IMAGE="node:24.22.2-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40"
KEEP_RELEASES=3
APP_SERVICES=(api web)

mkdir -p "${ROOT}/releases" "${BACKUPS}"
chmod 700 "${BACKUPS}"
exec 9>"${ROOT}/.deploy.lock"
flock -n 9 || { echo "Another deploy is running." >&2; exit 1; }

git -C "${REPO}" fetch --quiet --prune origin main
revision="$(git -C "${REPO}" rev-parse --verify "${1:-origin/main}^{commit}")"
release="${ROOT}/releases/${revision}"
previous="$(readlink "${ROOT}/current" || true)"
api_port="$(sed -n 's/^RAKAZO_API_PORT=//p' "${APP_DIR}/.env" | tail -n 1)"

healthy() { curl --fail --silent --max-time 10 -o /dev/null "http://127.0.0.1:${api_port:-3100}/health"; }

# Compose with the release's own files, so new settings arrive with the code that reads them.
compose() {
  local dir="$1"
  shift
  RAKAZO_SOURCE_DIR="${dir}" RAKAZO_SOURCE_REVISION="$(basename "${dir}")" \
    docker compose --project-directory "${APP_DIR}" --env-file "${APP_DIR}/.env" \
    -f "${dir}/infra/compose/docker-compose.images.yml" \
    -f "${dir}/infra/compose/docker-compose.source.yml" "$@"
}

if [[ "${previous}" == "${release}" ]] && healthy; then
  echo "Already running ${revision}."
  exit 0
fi

if [[ ! -e "${release}/.built" ]]; then
  echo "== Building ${revision}"
  rm -rf "${release}"
  mkdir -p "${release}"
  git -C "${REPO}" archive "${revision}" | tar -x -C "${release}"
  # The same mount path inside and out, so the store and releases hard-link on one filesystem.
  docker run --rm --user "$(id -u):$(id -g)" -v "${ROOT}:${ROOT}" -w "${release}" \
    -e HOME="${ROOT}/home" -e COREPACK_HOME="${ROOT}/corepack" -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e CI=true -e GIT_SHA="${revision}" -e NODE_OPTIONS=--max-old-space-size=3072 \
    "${NODE_IMAGE}" bash -Eeuo pipefail -c '
      pnpm() { corepack pnpm "$@"; }
      pnpm install --frozen-lockfile --prefer-offline --store-dir "$1/store" \
        --filter=. --filter="@rakazo/api..." --filter="@rakazo/worker..." \
        --filter="@rakazo/web..." --filter="@rakazo/sandbox-supervisor..."
      pnpm --filter @rakazo/db generate
      pnpm --filter @rakazo/api --filter @rakazo/worker build
      RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
      mkdir -p apps/web/asset-archive apps/web/node_modules/.vite-temp
      # Migrations call pnpm, which the runtime image has no copy of: ship this one.
      version="$(node -p "require(\"./package.json\").packageManager.split(\"@\")[1].split(\"+\")[0]")"
      mkdir -p .tools/bin
      cp -r "$COREPACK_HOME/v1/pnpm/$version" .tools/pnpm
      printf "#!/bin/sh\nexec node /app/.tools/pnpm/bin/pnpm.mjs \"\$@\"\n" >.tools/bin/pnpm
      chmod +x .tools/bin/pnpm
    ' build "${ROOT}"
  touch "${release}/.built"
fi

echo "== Backing up the database"
ts="$(date +%Y%m%d%H%M%S)"
docker exec rakazo-postgres-1 pg_dump -U rakazo -d rakazo -Fc >"${BACKUPS}/db-${ts}.dump"
chmod 600 "${BACKUPS}/db-${ts}.dump"
ls -1t "${BACKUPS}"/db-*.dump | tail -n +11 | xargs -r rm -f

# Starts a release's containers. The worker gets five minutes to hand back its running jobs.
start() {
  local dir="$1"
  compose "${dir}" up -d --no-deps --force-recreate --wait --wait-timeout 300 supervisor
  compose "${dir}" run --rm --no-deps -T migrate
  compose "${dir}" up -d --no-deps --force-recreate --wait --wait-timeout 300 "${APP_SERVICES[@]}"
  compose "${dir}" up -d --no-deps --force-recreate --timeout 300 worker
}

rollback() {
  trap - ERR
  echo "!! Deploy failed; restoring the previous release." >&2
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    ln -sfn "${previous}" "${ROOT}/current"
    start "${previous}"
  else
    # The first deploy from source replaced image containers; go back to the image.
    docker compose --project-directory "${APP_DIR}" --env-file "${APP_DIR}/.env" \
      -f "${APP_DIR}/docker-compose.images.yml" up -d --force-recreate --wait supervisor api worker web
  fi
  exit 1
}
trap rollback ERR

echo "== Starting ${revision}"
ln -sfn "${release}" "${ROOT}/current"
start "${release}"
for _ in {1..30}; do healthy && break; sleep 2; done
healthy
trap - ERR

# Keep the running release, the one before it, and the newest few others.
find "${ROOT}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2- |
  { grep -vxF -e "${release}" -e "${previous:-/}" || true; } | tail -n +"${KEEP_RELEASES}" | xargs -r rm -rf
echo "== Deployed ${revision}"
