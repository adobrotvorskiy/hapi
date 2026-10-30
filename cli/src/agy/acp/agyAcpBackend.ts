import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { AcpSdkBackend } from '@/agent/backends/acp/AcpSdkBackend'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { resolveHapiHomeDir } from '@/configuration'
import { splitAgyModelSelection } from '@hapi/protocol'

/** Native ACP owns authentication, credentials, tools and conversation storage. */
export function buildAgyAcpEnvironment(
    base: NodeJS.ProcessEnv,
    tempDirectory: string,
): Record<string, string> {
    const env: Record<string, string> = {}
    const excluded = new Set([
        'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
        'AGY_ACP_CCPA_PROJECT', 'AGY_ACP_ENABLE_OAUTH', 'GEMINI_FORCE_FILE_STORAGE',
        'GEMINI_HOME', 'ANTIGRAVITY_HARNESS_PATH', 'BROWSER',
    ])
    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined && !excluded.has(key.toUpperCase())) env[key] = value
    }
    const command = getAgentLaunchCommand('agy', base)
    const harness = base.HAPI_AGY_ACP_HARNESS_PATH
        || (isAbsolute(command) ? join(dirname(command), 'localharness_external') : undefined)
    return {
        ...env,
        GEMINI_HOME: base.HAPI_AGY_ACP_HOME || join(homedir(), '.gemini'),
        ...(harness ? { ANTIGRAVITY_HARNESS_PATH: harness } : {}),
        AGY_ACP_FORCE_FILE_STORAGE: '1',
        PYTHONUNBUFFERED: '1',
        TMPDIR: tempDirectory,
        // A server must not launch a browser or silently fall back to CLI auth.
        BROWSER: base.HAPI_AGY_ACP_BROWSER || (process.platform === 'win32' ? 'false' : '/bin/false'),
    }
}

export function createAgyAcpBackend(cwd: string) {
    const tempRoot = join(resolveHapiHomeDir(), 'antigravity-acp-tmp')
    mkdirSync(tempRoot, { recursive: true, mode: 0o700 })
    const tempDirectory = mkdtempSync(join(tempRoot, 'session-'))
    const backend = new AcpSdkBackend({
        command: getAgentLaunchCommand('agy'),
        args: process.platform === 'linux' ? ['--uid='] : [],
        env: buildAgyAcpEnvironment(process.env, tempDirectory),
        spawnCwd: cwd,
        flavor: 'agy',
        textChunkMode: 'delta',
        acpModelSwitchViaConfigOption: true,
    })
    return {
        backend,
        async dispose() {
            // close() awaits process-tree shutdown before its unpack directory is removed.
            await backend.disconnect()
            rmSync(tempDirectory, { recursive: true, force: true })
        },
    }
}

/** Resolve HAPI's grouped model/effort picker to an exact native catalog ID. */
export function resolveAgyAcpModel(
    model: string | null | undefined,
    effort: string | null | undefined,
    catalog: ReadonlyArray<{ modelId: string }>,
    currentModel?: string | null,
): string | null {
    if (!model) return null
    const exact = catalog.find((entry) => entry.modelId === model)
    if (exact && !effort) return exact.modelId
    const base = splitAgyModelSelection(model).model ?? model
    const candidate = effort ? `${base}-${effort}` : model
    if (catalog.some((entry) => entry.modelId === candidate)) return candidate
    if (!effort) {
        const variants = catalog.filter((entry) => splitAgyModelSelection(entry.modelId).model === base)
        const current = variants.find((entry) => entry.modelId === currentModel)
        if (current) return current.modelId
        if (variants[0]) return variants[0].modelId
    }
    throw new Error(`Antigravity ACP does not offer model ${model}${effort ? ` with effort ${effort}` : ''}`)
}
