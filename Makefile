# make test: run the ERT tests in test/ with e8 --batch, as CI does.
# make types: type-check the package against the E8 on PATH.
# make oracle: record what Magit shows, with Emacs (test/record.el).
# E8=/path/to/e8 make test, to use another E8.

E8 ?= e8
# The process tests answer prompts from processes' filters, and run in an
# E8 of their own: after them, a section toggle in the same E8 fails.
PROCESS_TESTS := test/magit-process-tests.ts
TESTS := $(filter-out $(PROCESS_TESTS),$(wildcard test/*-tests.ts))
# Packages the package requires, and those only its tests load, each
# owner/repository@tag, cloned into .e8/deps for the tests and tsc.
DEPS := e8-editor/e8-magit-section@v0.2.0 e8-editor/e8-with-editor@v0.1.0
DEP_DIRS := $(foreach d,$(DEPS),.e8/deps/$(notdir $(firstword $(subst @, ,$(d)))))
.PHONY: test types deps oracle

test: deps
	$(E8) --batch -L . -L test $(foreach d,$(DEP_DIRS),-L $(d)) $(foreach t,$(TESTS),-l $(t)) -f ert-run-tests-batch-and-exit
	$(E8) --batch -L . -L test $(foreach d,$(DEP_DIRS),-L $(d)) $(foreach t,$(PROCESS_TESTS),-l $(t)) -f ert-run-tests-batch-and-exit

types: deps
	$(E8) --print-types .e8
	tsc -p .

oracle:
	emacs -Q --batch -l test/record.el

deps:
	@for d in $(DEPS); do \
	  repo=$$(echo "$$d" | cut -d@ -f1); tag=$$(echo "$$d" | cut -d@ -f2); \
	  dir=.e8/deps/$$(basename "$$repo"); \
	  [ -e "$$dir" ] || git clone -q --depth 1 --branch "$$tag" "https://github.com/$$repo" "$$dir" || exit 1; \
	done
