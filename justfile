source_dir := "core-extension-source-files"
xpi := "dist/alias-reply-guard.xpi"

# List available commands.
default:
    @just --list

# Create a uv-managed Python environment, preserving existing packages.
venv:
    uv venv --allow-existing .venv

# Run the logic and mocked Thunderbird workflow checks.
test:
    node test/test.js

# Investigate draft reopening in an isolated Linux Thunderbird profile.
investigate-drafts:
    uv run --no-project --no-cache python test/draft-reopen-probe/run.py

# Test and build an installable XPI with manifest.json at its root.
package: test
    mkdir -p dist
    rm -f "{{xpi}}"
    cd "{{source_dir}}" && zip -r -X "../{{xpi}}" .

# Remove the generated XPI.
clean:
    rm -f "{{xpi}}"
