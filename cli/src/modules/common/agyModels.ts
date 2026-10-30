import { homedir } from 'node:os'
import type { AgyModelsResponse } from '@hapi/protocol/apiTypes'
import { createAgyAcpBackend } from '@/agy/acp/agyAcpBackend'

export type ListAgyModelsResponse = AgyModelsResponse
let cached: { response: AgyModelsResponse; at: number } | null = null
let inflight: Promise<AgyModelsResponse> | null = null
let catalogChangeListener: (() => void) | null = null
const FRESH_TTL_MS = 10 * 60_000

export function setAgyCatalogChangeListener(listener: (() => void) | null): void {
    catalogChangeListener = listener
}

/** Exact account catalog from official ACP; no CLI invocation or guessed fallback. */
export async function listAgyModels(options?: { refresh?: boolean }): Promise<ListAgyModelsResponse> {
    if (inflight) return inflight
    if (!options?.refresh && cached && Date.now() - cached.at >= 0 && Date.now() - cached.at < FRESH_TTL_MS) {
        return cached.response
    }
    inflight = fetchCatalog()
    try { return await inflight } finally { inflight = null }
}

async function fetchCatalog(): Promise<AgyModelsResponse> {
    const runtime = createAgyAcpBackend(homedir())
    try {
        await runtime.backend.initialize()
        const id = await runtime.backend.newSession({ cwd: homedir(), mcpServers: [] })
        const metadata = runtime.backend.getSessionModelsMetadata(id)
        if (!metadata?.availableModels.length) throw new Error('Official Antigravity ACP returned no available models')
        const response: AgyModelsResponse = { success: true, availableModels: metadata.availableModels }
        const changed = JSON.stringify(cached?.response) !== JSON.stringify(response)
        cached = { response, at: Date.now() }
        if (changed) {
            try { catalogChangeListener?.() } catch { /* Notification is best effort. */ }
        }
        return response
    } catch (error) {
        cached = null
        return { success: false, error: `Antigravity ACP: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
        await runtime.dispose()
    }
}

export function _resetAgyModelsCacheForTests(): void {
    cached = null
    inflight = null
    catalogChangeListener = null
}
