import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { AgySession } from '../session'
import { AgyAcpDriver } from './agyAcpDriver'
import type { createAgyAcpBackend } from './agyAcpBackend'

vi.mock('@/grok/utils/permissionHandler', () => ({
    GrokPermissionHandler: class { cancelAll = vi.fn().mockResolvedValue(undefined) },
}))

class TestDriver extends AgyAcpDriver {
    run() { return this.runMainLoop() }
    close() { return this.cleanup() }
}

function setup(nativeId: string | null = null) {
    const handlers = new Map<string, () => Promise<void>>()
    const backend = {
        initialize: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn().mockResolvedValue('native-id'),
        loadSession: vi.fn().mockResolvedValue('resumed-id'),
        setModel: vi.fn().mockResolvedValue(undefined),
        setMode: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        cancelPrompt: vi.fn().mockResolvedValue(undefined),
        getSessionModelsMetadata: vi.fn().mockReturnValue({
            currentModelId: 'gemini-4-argon-medium',
            availableModels: [{ modelId: 'gemini-4-argon-medium' }, { modelId: 'gemini-4-argon-high' }],
        }),
        onStderrError: vi.fn(), setSessionInfoUpdateListener: vi.fn(),
        refreshSessionInfo: vi.fn().mockResolvedValue(undefined),
    }
    const batch = { message: 'Hello', items: [{ localId: 'delivery-1' }], mode: {
        model: 'gemini-4-argon', effort: 'high', permissionMode: 'request-review',
    } }
    const session = {
        path: '/workspace', logPath: '', sessionId: nativeId,
        setKillHandler: vi.fn(), onSessionFound: vi.fn(), onThinkingChange: vi.fn(),
        sendSessionEvent: vi.fn(), sendAgentMessage: vi.fn(),
        queue: { waitForMessagesAndGetAsString: vi.fn().mockResolvedValueOnce(batch).mockResolvedValue(null), size: () => 0 },
        client: { emitSessionReady: vi.fn(), emitMessagesConsumed: vi.fn(), sendClaudeSessionMessage: vi.fn(),
            rpcHandlerManager: { registerHandler: (key: string, handler: () => Promise<void>) => handlers.set(key, handler) } },
    }
    const runtime = { backend, dispose: vi.fn().mockResolvedValue(undefined) }
    const driver = new TestDriver(session as unknown as AgySession, runtime as unknown as ReturnType<typeof createAgyAcpBackend>)
    return { driver, backend, session, runtime, handlers, batch }
}

beforeEach(() => vi.clearAllMocks())
describe('Antigravity ACP session lifecycle', () => {
    it('streams through native ACP with queued model and permission settings', async () => {
        const { driver, backend, session } = setup()
        backend.prompt.mockImplementation(async (_id, _content, update) => update({ type: 'text', text: 'ACP_OK' }))
        await driver.run()
        expect(backend.newSession).toHaveBeenCalledWith({ cwd: '/workspace', mcpServers: [] })
        expect(backend.setModel).toHaveBeenCalledWith('native-id', 'gemini-4-argon-high', { flavor: 'agy' })
        expect(backend.setMode).toHaveBeenCalledWith('native-id', 'default')
        expect(session.client.emitMessagesConsumed).toHaveBeenCalledWith(['delivery-1'])
        expect(session.sendAgentMessage).toHaveBeenCalledWith({ type: 'message', message: 'ACP_OK' })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        await driver.close()
    })
    it('loads the exact native conversation and never silently replaces a failed resume', async () => {
        const { driver, backend, session } = setup('previous-native-id')
        backend.loadSession.mockRejectedValue(new Error('Conversation missing'))
        await expect(driver.run()).rejects.toThrow('Conversation missing')
        expect(backend.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'previous-native-id' }))
        expect(backend.newSession).not.toHaveBeenCalled()
        expect(session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
        await driver.close()
    })
    it('restores a prompt when model selection fails before dispatch', async () => {
        const { driver, backend, session } = setup()
        backend.setModel.mockRejectedValue(new Error('Model unavailable'))
        await driver.run()
        expect(backend.prompt).not.toHaveBeenCalled()
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'abort-restore', text: 'Hello' })
        await driver.close()
    })
    it('does not retry a dispatched prompt after an indeterminate failure', async () => {
        const { driver, backend, session } = setup()
        backend.prompt.mockRejectedValue(new Error('Connection lost'))
        await driver.run()
        expect(backend.prompt).toHaveBeenCalledOnce()
        expect(session.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'abort-restore' }))
        await driver.close()
    })
    it('aborts native inference without ending the reusable session', async () => {
        const { driver, backend, session, handlers } = setup()
        let resolvePrompt!: () => void
        let reachedPrompt!: () => void
        const reached = new Promise<void>((resolve) => { reachedPrompt = resolve })
        backend.prompt.mockImplementation(() => { reachedPrompt(); return new Promise<void>((resolve) => { resolvePrompt = resolve }) })
        const running = driver.run()
        await reached
        await handlers.get(RPC_METHODS.Abort)!()
        expect(backend.cancelPrompt).toHaveBeenCalledWith('native-id')
        resolvePrompt()
        await running
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        await driver.close()
    })
})
