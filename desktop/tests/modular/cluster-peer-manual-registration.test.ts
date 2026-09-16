// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonRpcNotification, JsonValue } from '@/electron/service-bridge/json-rpc-subprocess'

// Membership can arrive without discovery ever carrying the peer: an invite
// accepted here (the inviter's side registers at invite time, the accepting
// side previously registered nothing), or a third node's membership push. On a
// network with no multicast such a peer stayed paired-but-invisible — the
// relay consumers key off discovery, and no record ever arrived for it. These
// tests pin that a confirmed member no discovery record carries is registered
// as a manual node, and that discovered, already-manual, pending, and self
// entries are left alone.
const mocks = vi.hoisted(() => ({
    bridgeState: {
        getSelfId: vi.fn(() => 'self-uuid'),
        // UUID → addresses the discovery-fed state knows. Empty = undiscovered.
        getNodeAddresses: vi.fn((): string[] => []),
        reconcilePendingInvitesWithMembers: vi.fn()
    },
    addManualNodeEntry: vi.fn((address: string) => ({
        id: address,
        address,
        name: address
    })),
    hasManualNodeEntryFor: vi.fn((): boolean => false),
    emitBridgePush: vi.fn()
}))

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getAppPath: () => process.cwd()
    }
}))

vi.mock('@/shared/utils/log', () => ({
    createStructuredLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        verbose: vi.fn()
    })
}))

vi.mock('@/electron/config/ui-config', () => ({
    isFirstRun: () => false
}))

vi.mock('@/electron/service-bridge/broadcaster', () => ({
    emitBridgePush: mocks.emitBridgePush
}))

vi.mock('@/electron/service-bridge/manual-nodes-store', () => ({
    listManualNodeEntries: () => [],
    manualPortsToWire: () => undefined,
    addManualNodeEntry: mocks.addManualNodeEntry,
    hasManualNodeEntryFor: mocks.hasManualNodeEntryFor
}))

vi.mock('@/electron/service-bridge/node-info-poller', () => ({
    startNodeInfoPoller: vi.fn(),
    stopNodeInfoPoller: vi.fn()
}))

vi.mock('@/electron/service-bridge/modular-state', () => ({
    getModularBridgeState: () => mocks.bridgeState,
    isProxyEngine: () => false,
    isUpstreamUnreachableError: () => false,
    parseServiceErrors: () => [],
    parseWorkloadsInitial: () => [],
    PROXY_ENGINES: ['ollama', 'lm-studio']
}))

import { getModularSupervisor } from '@/electron/service-bridge/modular-supervisor'

interface SupervisorHarness {
    handleNotification: (notification: JsonRpcNotification) => void
    refreshAllRemoteEngineStatus: () => Promise<void>
}

const supervisor = getModularSupervisor() as unknown as SupervisorHarness

/** Spy the broker RPC surface the registration path uses, mock-success per call. */
function spyCallProcess() {
    return vi.spyOn(getModularSupervisor(), 'callProcess').mockResolvedValue({ added: true })
}

function membershipChanged(nodes: JsonValue[]): void {
    supervisor.handleNotification({
        source: 'broker',
        method: 'nodes:changed',
        params: { nodes }
    })
}

// A cluster membership record off the wire. Deliberately synthetic values
// (RFC 5737 documentation address, .local host) so no real network leaks into
// the fixture — any address works here; production takes what the broker sends.
const wireMember = {
    id: 'pair-peer-a.local',
    nodeUuid: 'uuid-peer-a',
    name: 'pair-peer-a.local',
    ipAddress: '198.51.100.10',
    port: 14321,
    clusterId: 'cluster-1',
    state: 'member'
}

describe('registering cluster members no discovery record carries', () => {
    let callProcess: ReturnType<typeof spyCallProcess>

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.bridgeState.getNodeAddresses.mockReturnValue([])
        mocks.hasManualNodeEntryFor.mockReturnValue(false)
        mocks.bridgeState.getSelfId.mockReturnValue('self-uuid')
        callProcess = spyCallProcess()
        vi.spyOn(getModularSupervisor(), 'hasProcess').mockReturnValue(true)
        vi.spyOn(supervisor, 'refreshAllRemoteEngineStatus').mockResolvedValue(undefined)
    })

    it('registers an undiscovered member by its cluster-recorded address', async () => {
        membershipChanged([wireMember])

        await vi.waitFor(() => {
            expect(callProcess).toHaveBeenCalledWith('broker', 'node/add', {
                address: '198.51.100.10',
                name: '198.51.100.10'
            })
        })
        expect(mocks.addManualNodeEntry).toHaveBeenCalledWith('198.51.100.10')
    })

    it('leaves a discovered member to the scanner record', async () => {
        mocks.bridgeState.getNodeAddresses.mockReturnValue(['192.0.2.10'])

        membershipChanged([wireMember])
        await vi.waitFor(() => {
            expect(mocks.emitBridgePush).toHaveBeenCalledWith('nodes:changed', expect.anything())
        })

        expect(mocks.addManualNodeEntry).not.toHaveBeenCalled()
        expect(callProcess).not.toHaveBeenCalledWith('broker', 'node/add', expect.anything())
    })

    it('does not re-register a member a manual entry already owns', async () => {
        mocks.hasManualNodeEntryFor.mockReturnValue(true)

        membershipChanged([wireMember])
        await vi.waitFor(() => {
            expect(mocks.emitBridgePush).toHaveBeenCalledWith('nodes:changed', expect.anything())
        })

        expect(mocks.addManualNodeEntry).not.toHaveBeenCalled()
        expect(callProcess).not.toHaveBeenCalledWith('broker', 'node/add', expect.anything())
    })

    it('skips pending memberships and this node itself', async () => {
        membershipChanged([
            { ...wireMember, nodeUuid: 'self-uuid' },
            { ...wireMember, nodeUuid: 'uuid-pending', state: 'pending-outbound' }
        ])
        await vi.waitFor(() => {
            expect(mocks.emitBridgePush).toHaveBeenCalledWith('nodes:changed', expect.anything())
        })

        expect(mocks.addManualNodeEntry).not.toHaveBeenCalled()
        expect(callProcess).not.toHaveBeenCalledWith('broker', 'node/add', expect.anything())
    })
})
