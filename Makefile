.PHONY: up down test build import logs reset-data
up:            ## start n8n (http://localhost:5678)
	docker compose up -d n8n
down:
	docker compose down
test:          ## unit + integration tests (no network, no API quota)
	node --test tests/*.test.js
build:         ## regenerate workflows/*.json from src/
	python3 scripts/build_workflows.py
import: build  ## load the workflows into the running n8n
	docker compose exec -T n8n n8n import:workflow --separate --input=/workflows/
logs:
	docker compose logs -f n8n
reset-data:    ## wipe the local store/outbox (not the Sheet)
	rm -rf n8n_data/bdr
