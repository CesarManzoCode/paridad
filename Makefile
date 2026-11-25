# Interfaz de verificación de paridad (sección 8 de vault/CONTRACT.md).
SHELL := /bin/bash

TS_TESTS = $(shell find . \( -name node_modules -o -name .venv -o -name .git -o -name .paridad -o -name vault -o -path ./generator/templates \) -prune -o -name '*.test.ts' -print | sort)

.PHONY: bootstrap generate check verify battery

bootstrap:
	pnpm install --frozen-lockfile
	python3 -m venv .venv
	.venv/bin/pip install --quiet -r requirements-dev.txt
	cd tools && go mod download
	cd harness/oracle/official-go && go mod download

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

# A failed recipe makes GNU make exit 2, which would turn the 77 of an omitted
# criterion into a failure; with Guile, make exits with the code of the runner.
verify:
ifneq ($(filter guile,$(.FEATURES)),)
	@$(guile (begin $(if $(SURFACES),(setenv "SURFACES" "$(SURFACES)")) (display "node verify/run.ts $(C)\n") (force-output) (primitive-exit (or (status:exit-val (system* "node" "verify/run.ts" "$(C)")) 1))))
else
	$(if $(SURFACES),SURFACES=$(SURFACES)) node verify/run.ts $(C)
endif

battery:
	node verify/battery.ts
