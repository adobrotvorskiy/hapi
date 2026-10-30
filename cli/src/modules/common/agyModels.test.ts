import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ initialize: vi.fn(), newSession: vi.fn(), metadata: vi.fn(), dispose: vi.fn(), create: vi.fn() }))
vi.mock('@/agy/acp/agyAcpBackend', () => ({ createAgyAcpBackend: mocks.create }))
import { listAgyModels, _resetAgyModelsCacheForTests, setAgyCatalogChangeListener } from './agyModels'

const models = [{ modelId: 'gemini-native-high', name: 'Native Gemini' }]
beforeEach(() => {
    vi.resetAllMocks()
    _resetAgyModelsCacheForTests()
    mocks.initialize.mockResolvedValue(undefined)
    mocks.newSession.mockResolvedValue('native-session')
    mocks.metadata.mockReturnValue({ availableModels: models })
    mocks.dispose.mockResolvedValue(undefined)
    mocks.create.mockReturnValue({ backend: { initialize: mocks.initialize, newSession: mocks.newSession, getSessionModelsMetadata: mocks.metadata }, dispose: mocks.dispose })
})
describe('official Antigravity ACP catalog', () => {
    it('uses the native account catalog and releases the agent', async () => {
        expect(await listAgyModels()).toEqual({ success: true, availableModels: models })
        expect(mocks.newSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }))
        expect(mocks.dispose).toHaveBeenCalledOnce()
    })
    it('shares concurrent probes and caches successful catalog reads', async () => {
        await Promise.all([listAgyModels(), listAgyModels()])
        await listAgyModels()
        expect(mocks.create).toHaveBeenCalledOnce()
        await listAgyModels({ refresh: true })
        expect(mocks.create).toHaveBeenCalledTimes(2)
    })
    it('does not offer stale or invented models after an authentication failure', async () => {
        await listAgyModels()
        mocks.newSession.mockRejectedValue(new Error('Authentication required'))
        const response = await listAgyModels({ refresh: true })
        expect(response).toEqual({ success: false, error: expect.stringContaining('Authentication required') })
        expect(response.availableModels).toBeUndefined()
        expect(mocks.dispose).toHaveBeenCalledTimes(2)
    })
    it('rejects empty native catalogs', async () => {
        mocks.metadata.mockReturnValue({ availableModels: [] })
        expect(await listAgyModels()).toMatchObject({ success: false })
        expect(mocks.dispose).toHaveBeenCalledOnce()
    })
    it('does not let a listener failure break model discovery', async () => {
        setAgyCatalogChangeListener(() => { throw new Error('listener failure') })
        expect(await listAgyModels()).toMatchObject({ success: true })
    })
})
