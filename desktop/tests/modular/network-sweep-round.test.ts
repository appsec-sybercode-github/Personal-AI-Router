// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as osTypes from 'os'

const mocks = vi.hoisted(() => {
    return {
        state: {
            getSelfId: vi.fn<() => string | null>(),
            upsertSweptNode: vi.fn(),
            mergeNodeInfoResponse: vi.fn(),
            reconcileSweptNodes: vi.fn()
        },
        uiConfig: {
            enabled: true as boolean,
            ports: [14318] as number[]
        },
        // Reassigned per test: what os.networkInterfaces() reports.
        osInterfaces: {} as NodeJS.Dict<osTypes.NetworkInterfaceInfo[]>,
        // What the stubbed TCP stack would accept, plus every connect attempted.
        netStub: {
            openEndpoints: new Set<string>(),
            connects: [] as { host: string; port: number }[]
        }
    }
})

vi.mock('@/electron/service-bridge/modular-state', () => ({
    getModularBridgeState: () => mocks.state
}))

vi.mock('@/electron/config/ui-config', () => ({
    isNetworkSweepEnabled: () => mocks.uiConfig.enabled,
    getNetworkSweepPorts: () => mocks.uiConfig.ports
}))

vi.mock('@/shared/utils/log', () => ({
    createStructuredLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        verbose: vi.fn()
    })
}))

vi.mock('os', async importOriginal => {
    const actual = await importOriginal<typeof import('os')>()
    return { ...actual, networkInterfaces: () => mocks.osInterfaces }
})

vi.mock('net', async () => {
    const { EventEmitter } = await import('node:events')
    // Connect settles asynchronously like the real stack, succeeding only for
    // endpoints the test marked open; everything else is a refusal.
    class StubSocket extends EventEmitter {
        connect(port: number, host: string): StubSocket {
            mocks.netStub.connects.push({ host, port })
            queueMicrotask(() => {
                if (mocks.netStub.openEndpoints.has(`${host}:${port}`)) {
                    this.emit('connect')
                } else {
                    this.emit('error', new Error(`connect ECONNREFUSED ${host}:${port}`))
                }
            })
            return this
        }
        destroy(): void {
            /* the sweep always destroys on settle */
        }
    }
    return { Socket: StubSocket }
})

import { sweepNetworkOnce } from '@/electron/service-bridge/network-sweep'

const fetchMock = vi.fn<typeof fetch>()

/** One non-internal IPv4 interface entry, cidr included as POSIX reports it. */
function v4(address: string, prefix: number, internal = false): osTypes.NetworkInterfaceInfo {
    return {
        family: 'IPv4',
        address,
        netmask: '255.255.255.0',
        mac: '00:00:00:00:00:00',
        cidr: `${address}/${prefix}`,
        internal,
        scopeid: 0
    } as osTypes.NetworkInterfaceInfo
}

/** A machine on both its LAN and an OpenVPN /24. */
function lanAndVpnInterfaces(): NodeJS.Dict<osTypes.NetworkInterfaceInfo[]> {
    return {
        en0: [v4('192.0.2.8', 24)],
        utun3: [v4('198.51.100.8', 24)],
        lo0: [v4('127.0.0.1', 8, true)]
    }
}

/** Answer node-info as the marked-open endpoint's host would. */
function nodeInfoFor(hostUuid: string, name?: string): Response {
    return new Response(JSON.stringify({ hostUuid, ...(name ? { name } : {}) }), { status: 200 })
}

function confirmedIds(): string[] {
    expect(mocks.state.reconcileSweptNodes).toHaveBeenCalled()
    const confirmed = mocks.state.reconcileSweptNodes.mock.calls.at(-1)?.[0] as Set<string>
    return [...confirmed]
}

// One sweep round end to end: interfaces become a probe plan, TCP connects
// filter it, node-info verifies it, and only verified PAIR hosts reach the
// bridge state — with the port that answered, never an assumed default.
describe('network sweep round', () => {
    beforeEach(() => {
        mocks.state.getSelfId.mockReturnValue('uuid-self')
        mocks.state.upsertSweptNode.mockClear()
        mocks.state.mergeNodeInfoResponse.mockClear()
        mocks.state.reconcileSweptNodes.mockClear()
        mocks.uiConfig.enabled = true
        mocks.uiConfig.ports = [14318]
        mocks.osInterfaces = lanAndVpnInterfaces()
        mocks.netStub.openEndpoints.clear()
        mocks.netStub.connects.length = 0
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('probes both /24 windows and upserts a VPN peer it verifies, with telemetry', async () => {
        mocks.netStub.openEndpoints.add('198.51.100.205:14318')
        // fetch only ever runs for a host whose TCP connect succeeded, so one
        // answer for the one open endpoint is the whole HTTP traffic of the round.
        fetchMock.mockResolvedValue(nodeInfoFor('uuid-vpn-peer', 'vpn-box'))

        await sweepNetworkOnce('interval')

        // 253 probeable hosts per /24 (254 minus this machine's own address).
        expect(mocks.netStub.connects).toHaveLength(506)
        expect(mocks.state.upsertSweptNode).toHaveBeenCalledWith({
            id: 'uuid-vpn-peer',
            address: '198.51.100.205',
            port: 14318,
            name: 'vpn-box'
        })
        expect(mocks.state.mergeNodeInfoResponse).toHaveBeenCalledWith(
            'uuid-vpn-peer',
            expect.objectContaining({ hostUuid: 'uuid-vpn-peer' })
        )
        expect(confirmedIds()).toEqual(['uuid-vpn-peer'])
    })

    it('does not record this machine when the VPN routes its own address back', async () => {
        mocks.netStub.openEndpoints.add('198.51.100.99:14318')
        fetchMock.mockResolvedValue(nodeInfoFor('uuid-self'))

        await sweepNetworkOnce('interval')

        expect(mocks.state.upsertSweptNode).not.toHaveBeenCalled()
        expect(mocks.state.mergeNodeInfoResponse).not.toHaveBeenCalled()
        expect(confirmedIds()).toEqual([])
    })

    it('skips an answer that carries no hostUuid — it cannot be keyed to a node', async () => {
        mocks.netStub.openEndpoints.add('198.51.100.100:14318')
        fetchMock.mockResolvedValue(nodeInfoFor(''))

        await sweepNetworkOnce('interval')

        expect(mocks.state.upsertSweptNode).not.toHaveBeenCalled()
        expect(confirmedIds()).toEqual([])
    })

    it('never issues an HTTP request for a host whose TCP connect is refused', async () => {
        await sweepNetworkOnce('interval')

        expect(mocks.netStub.connects).toHaveLength(506)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(mocks.state.upsertSweptNode).not.toHaveBeenCalled()
        expect(confirmedIds()).toEqual([])
    })

    it('records the port that answered when the peer is not on the default one', async () => {
        mocks.uiConfig.ports = [14318, 24318]
        mocks.netStub.openEndpoints.add('198.51.100.205:24318')
        fetchMock.mockResolvedValue(nodeInfoFor('uuid-moved-port', 'moved-port-box'))

        await sweepNetworkOnce('interval')

        // Each host is asked on both configured ports.
        expect(mocks.netStub.connects).toHaveLength(1012)
        expect(mocks.state.upsertSweptNode).toHaveBeenCalledWith({
            id: 'uuid-moved-port',
            address: '198.51.100.205',
            port: 24318,
            name: 'moved-port-box'
        })
        expect(confirmedIds()).toEqual(['uuid-moved-port'])
    })

    it('probes nothing and drops swept nodes when the sweep is disabled', async () => {
        mocks.uiConfig.enabled = false

        await sweepNetworkOnce('interval')

        expect(mocks.netStub.connects).toHaveLength(0)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(mocks.state.upsertSweptNode).not.toHaveBeenCalled()
        expect(mocks.state.reconcileSweptNodes).toHaveBeenCalledWith(new Set())
    })

    it('reconciles to empty when there is no interface left to sweep', async () => {
        // The VPN went down and the NIC with it: nothing can be confirmed, so
        // the previous round's swept nodes are withdrawn.
        mocks.osInterfaces = { lo0: [v4('127.0.0.1', 8, true)] }

        await sweepNetworkOnce('interval')

        expect(mocks.netStub.connects).toHaveLength(0)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(mocks.state.reconcileSweptNodes).toHaveBeenCalledWith(new Set())
    })
})
