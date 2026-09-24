# agentdesk-annotator tasks. Server runs TypeScript directly on Node 24.

default:
  @just --list

# Typecheck, unit and integration tests, extension build.
check: typecheck test build-extension

typecheck:
  npx tsc -p tsconfig.json
  npx tsc -p extension/tsconfig.json

test:
  node --test "server/test/**/*.test.ts"

# Bundle the extension into extension/dist (load unpacked from there).
build-extension:
  node extension/build.ts

# End-to-end through the live Cloudflare edge with the annotator-e2e service token.
e2e env="~/.config/agentdesk-annotator/e2e.env":
  set -a && . {{env}} && set +a && node --test "e2e/**/*.test.ts"

# Deploy main to oracle: pull, rebuild, restart, then run the edge e2e there.
deploy:
  ssh oracle 'cd ~/apps/agentdesk-annotator && git pull --ff-only && cd deploy && docker compose up -d --build && docker compose ps'
  ssh oracle 'cd ~/apps/agentdesk-annotator && npm ci --silent && set -a && . deploy/.env && set +a && node --test "e2e/**/*.test.ts"'

# Tail production logs on oracle.
logs:
  ssh oracle 'cd ~/apps/agentdesk-annotator/deploy && docker compose logs -f --tail 100 server'

# Consistent SQLite snapshot into the data volume's backups/ directory.
backup:
  ssh oracle 'cd ~/apps/agentdesk-annotator/deploy && docker compose exec -T server node server/src/backup.ts'
