# Interfaz de verificación de paridad (sección 8 de vault/CONTRACT.md).
SHELL := /bin/bash

TS_TESTS = $(shell find . \( -name node_modules -o -name .venv -o -name .git -o -name .paridad -o -name vault \) -prune -o -name '*.test.ts' -print | sort)

.PHONY: bootstrap generate check verify battery

bootstrap:
	pnpm install --frozen-lockfile
	python3 -m venv .venv
	.venv/bin/pip install --quiet -r requirements-dev.txt
	cd tools && go mod download

generate:
	node generator/src/main.ts

check: bootstrap
	pnpm -r --if-present run check
	node --test $(TS_TESTS)
	@if [ -f sdks/python/pyproject.toml ]; then \
		.venv/bin/mypy --strict sdks/python/src/paridad_resend && .venv/bin/pytest sdks/python; \
	fi
	@if [ -f sdks/go/go.mod ]; then \
		cd sdks/go && go vet ./... && go test ./...; \
	fi

verify:
	$(if $(SURFACES),SURFACES=$(SURFACES)) node verify/run.ts $(C)

battery:
	node verify/battery.ts
