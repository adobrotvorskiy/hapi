import React from 'react'
import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@/agent/types'
import { convertAgentMessage } from '@/agent/messageConverter'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { logger } from '@/ui/logger'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason,
} from '@/modules/common/remote/RemoteLauncherBase'
import { GrokPermissionHandler } from '@/grok/utils/permissionHandler'
import type { AgySession } from '../session'
import type { PermissionMode } from '../types'
import { createAgyAcpBackend, resolveAgyAcpModel } from './agyAcpBackend'

export class AgyAcpDriver extends RemoteLauncherBase {
    private readonly controller = new AbortController()
    private readonly runtime: ReturnType<typeof createAgyAcpBackend>
    private permissions: GrokPermissionHandler | null = null
    private nativeSessionId: string | null = null
    private currentModel: string | null = null
    private defaultModel: string | null = null
    private turnPermission: PermissionMode = 'request-review'
    private activeTurn: Promise<void> | null = null
    private turnAborted = false

    constructor(
        private readonly session: AgySession,
        runtime?: ReturnType<typeof createAgyAcpBackend>,
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
        this.runtime = runtime ?? createAgyAcpBackend(session.path)
        session.setKillHandler(() => this.shutdown())
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.requestExit('exit', () => this.shutdown()) })
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context)
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session
        const backend = this.runtime.backend
        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.cancelTurn(),
            onSwitch: async () => {},
        })
        backend.onStderrError((error) => {
            logger.debug('[agy-acp] native agent stderr', error)
        })
        backend.setSessionInfoUpdateListener(({ title }) => {
            if (title) session.client.sendClaudeSessionMessage({ type: 'summary', summary: title, leafUuid: randomUUID() })
        })
        this.permissions = new GrokPermissionHandler(session.client, backend, () =>
            this.turnPermission === 'always-proceed' ? 'bypassPermissions' : 'default')

        try {
            await backend.initialize()
            const config = { cwd: session.path, mcpServers: [] }
            // A failed resume must never silently create an empty native conversation.
            this.nativeSessionId = session.sessionId
                ? await backend.loadSession({ ...config, sessionId: session.sessionId })
                : await backend.newSession(config)
            session.onSessionFound(this.nativeSessionId)
            const metadata = backend.getSessionModelsMetadata(this.nativeSessionId)
            this.currentModel = metadata?.currentModelId ?? null
            this.defaultModel = this.currentModel
            session.client.emitSessionReady()
            session.sendSessionEvent({ type: 'message', message: 'Connected to official Google Antigravity ACP.' })
            await backend.refreshSessionInfo(this.nativeSessionId, session.path).catch(() => {})

            while (!this.shouldExit && !this.controller.signal.aborted) {
                const batch = await session.queue.waitForMessagesAndGetAsString(this.controller.signal)
                if (!batch) break
                this.turnAborted = false
                this.turnPermission = batch.mode.permissionMode
                session.onThinkingChange(true)
                let dispatched = false
                const localIds = (batch.items ?? []).flatMap((item) => item.localId ? [item.localId] : [])
                const turn = (async () => {
                    try {
                        const catalog = backend.getSessionModelsMetadata(this.nativeSessionId!)?.availableModels ?? []
                        const requested = resolveAgyAcpModel(batch.mode.model, batch.mode.effort, catalog, this.currentModel) ?? this.defaultModel
                        if (requested && requested !== this.currentModel) {
                            await backend.setModel(this.nativeSessionId!, requested, { flavor: 'agy' })
                            this.currentModel = requested
                        }
                        // Native permission mode remains authoritative; the web answers its requests.
                        await backend.setMode(this.nativeSessionId!, this.turnPermission === 'always-proceed' ? 'yolo' : 'default')
                        if (this.turnAborted || this.controller.signal.aborted) return
                        // Never retry a prompt after dispatch: its tool effects may have happened.
                        dispatched = true
                        session.client.emitMessagesConsumed(localIds)
                        await backend.prompt(this.nativeSessionId!, [{ type: 'text', text: batch.message }],
                            (message) => this.forwardMessage(message))
                    } catch (error) {
                        if (!this.turnAborted) {
                            session.sendSessionEvent({ type: 'error', message: `Antigravity ACP: ${error instanceof Error ? error.message : String(error)}` })
                        }
                    } finally {
                        if (!dispatched) {
                            session.client.emitMessagesConsumed(localIds)
                            session.sendSessionEvent({ type: 'abort-restore', text: batch.message })
                        }
                        await this.permissions?.cancelAll('Turn finished')
                        session.onThinkingChange(false)
                        if (!this.controller.signal.aborted && session.queue.size() === 0) session.sendSessionEvent({ type: 'ready' })
                    }
                })()
                this.activeTurn = turn
                try { await turn } finally { this.activeTurn = null }
            }
        } catch (error) {
            session.sendSessionEvent({ type: 'error', message: `Cannot start Antigravity ACP: ${error instanceof Error ? error.message : String(error)}` })
            throw error
        }
    }

    private forwardMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message, this.currentModel)
        if (converted) this.session.sendAgentMessage(converted)
    }

    private async cancelTurn(): Promise<void> {
        this.turnAborted = true
        await this.permissions?.cancelAll('Turn interrupted')
        if (this.nativeSessionId && this.activeTurn) await this.runtime.backend.cancelPrompt(this.nativeSessionId)
    }

    private async shutdown(): Promise<void> {
        this.controller.abort()
        this.shouldExit = true
        // Closing the transport unblocks pending startup/model/prompt RPCs and kills native tool children.
        await this.cancelTurn().catch(() => {})
        await this.runtime.dispose()
        await this.activeTurn
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.permissions?.cancelAll('Session ended')
        await this.runtime.dispose()
    }
}

export async function agyAcpDriver(session: AgySession): Promise<'switch' | 'exit'> {
    return new AgyAcpDriver(session).launch()
}
