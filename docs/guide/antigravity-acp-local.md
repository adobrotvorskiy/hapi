# Antigravity ACP in this local build

This build replaces the Antigravity remote driver and model discovery with
Google's official Antigravity ACP executable. It never falls back to `agy -p`,
`agy models`, direct model requests, or extracted subscription tokens.

Set these variables on the HAPI runner:

- `HAPI_AGY_ACP_PATH`: absolute path to Google's unmodified `agy_acp_server.par`
  (or the platform equivalent).
- `HAPI_AGY_ACP_HOME`: native Gemini profile directory. The agent expects
  `antigravity-acp/settings.json` and performs authentication itself. An existing
  signed-in ACP profile may be selected without copying or reading its token.
- `HAPI_AGY_ACP_HARNESS_PATH`: optional path to the matching
  `localharness_external` helper; defaults to the executable's directory.

The default executable name is `antigravity-acp`. Installation of Google's
runtime and interactive initial OAuth login are external setup steps; this
build does not add a provider-login screen to HAPI. If you select an existing
native profile also used by another ACP client, signing out of that profile
affects both clients.

The web app remains the standard HAPI client. Native ACP supplies the model
catalog, prompt streaming, permission requests, cancellation and conversation
resume. HAPI maps Request review to ACP Default and Always proceed to ACP YOLO.
A failed native resume is reported rather than replaced with an empty chat.

To enable the standard workspace browser, pass repeated `--workspace-root`
arguments to `hapi runner start-sync`, for example:

```sh
hapi runner start-sync --workspace-root /path/to/projects
```

## Keeping the fork current

The upstream remote is `https://github.com/tiann/hapi.git`. Merge its main branch
into this fork, resolve any adapter conflicts, and run the CLI typecheck and
the focused ACP/catalog/session tests before rebuilding. Updating the official
npm package alone does not include these source changes.

```sh
git fetch upstream
git merge upstream/main
bun install --frozen-lockfile
bun run typecheck:cli
bun run test:cli src/agy/acp src/agy/runAgy.test.ts src/agy/session.test.ts src/modules/common/agyModels.test.ts src/grok/utils/permissionHandler.test.ts
bun run download:tunwg
bun run --cwd cli build:exe
```

These are local integration changes, not a statement of vendor approval.
