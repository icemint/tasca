# Tasca self-host helpers. See SELF_HOST.md.
.PHONY: up down logs ps base

# Build the shared base image (heavy: native toolchain + agent CLI + the emdash vendor),
# then build + start the stack. The worker/runner images are FROM tasca-base:latest, so
# the base must exist before compose builds them.
up: base
	docker compose up -d --build

base:
	docker build -f deploy/base.Dockerfile -t tasca-base:latest .

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps
