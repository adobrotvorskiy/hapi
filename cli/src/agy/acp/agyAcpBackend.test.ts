import { describe, expect, it } from 'vitest'
import { buildAgyAcpEnvironment, resolveAgyAcpModel } from './agyAcpBackend'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'

describe('Antigravity official ACP launch', () => {
    it('uses the official ACP command instead of the ordinary CLI', () => {
        expect(getAgentLaunchCommand('agy', {})).toBe('antigravity-acp')
        expect(getAgentLaunchCommand('agy', { HAPI_AGY_ACP_PATH: '/official/agy_acp_server.par' })).toBe('/official/agy_acp_server.par')
    })
    it('selects native OAuth without ambient API credentials', () => {
        const env = buildAgyAcpEnvironment({
            PATH: '/usr/bin', HAPI_AGY_ACP_PATH: '/official/agy_acp_server.par',
            HAPI_AGY_ACP_HOME: '/native/profile', GEMINI_API_KEY: 'wrong-key', GOOGLE_API_KEY: 'wrong-key',
            GOOGLE_APPLICATION_CREDENTIALS: '/wrong/file', GEMINI_HOME: '/wrong/profile',
            ANTIGRAVITY_HARNESS_PATH: '/wrong/harness',
        }, '/owned/tmp')
        expect(env.GEMINI_HOME).toBe('/native/profile')
        expect(env.ANTIGRAVITY_HARNESS_PATH).toBe('/official/localharness_external')
        expect(env.TMPDIR).toBe('/owned/tmp')
        expect(env).not.toHaveProperty('GEMINI_API_KEY')
        expect(env).not.toHaveProperty('GOOGLE_API_KEY')
        expect(env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS')
    })
    it('does not invent a helper path relative to the project when the executable is on PATH', () => {
        const env = buildAgyAcpEnvironment({ PATH: '/usr/bin' }, '/owned/tmp')
        expect(env).not.toHaveProperty('ANTIGRAVITY_HARNESS_PATH')
    })
    it('resolves grouped effort choices only to models actually offered by the native agent', () => {
        const catalog = [{ modelId: 'gemini-4-argon-medium' }, { modelId: 'gemini-4-argon-high' }]
        expect(resolveAgyAcpModel('gemini-4-argon', 'high', catalog)).toBe('gemini-4-argon-high')
        expect(resolveAgyAcpModel('gemini-4-argon-medium', null, catalog)).toBe('gemini-4-argon-medium')
        expect(() => resolveAgyAcpModel('gemini-4-argon', 'max', catalog)).toThrow('does not offer')
        expect(resolveAgyAcpModel(null, null, catalog)).toBeNull()
    })
})
