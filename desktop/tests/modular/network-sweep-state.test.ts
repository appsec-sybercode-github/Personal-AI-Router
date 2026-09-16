// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('@/electron/window', () => ({ createOverviewWindow: vi.fn() }))

import { getModularBridgeState } from '@/electron/service-bridge/modular-state'

function brokerSnapshot(
    nodes: {
        hostUuid: string
        name: string
        ipAddress: string
        trusted?: boolean
        clustered?: boolean
    }[]
): void {
    getModularBridgeState().handleNotification({
        source: 'broker',
        method: 'discovery:nodes-changed',
        params: {
            nodes: nodes.map(node => ({
                hostUuid: node.hostUuid,
                name: node.name,
                ipAddress: node.ipAddress,
                port: 14318,
                lastSeen: Date.now(),
                trusted: node.trusted ?? false,
                clustered: node.clustered ?? false
            }))
        }
    })
}

function available(id: string) {
    return getModularBridgeState()
        .getAvailableNodes()
        .find(node => node.id === id)
}

function pollTarget(id: string) {
    return getModularBridgeState()
        .getNodeInfoPollTargets()
        .find(target => target.id === id)
}

function isStored(id: string): boolean {
    return Boolean(getModularBridgeState().getNodesInitial().nodes[id])
}

// The subnet sweep's findings land as a 'sweep'-sourced contribution to the
// bridge's multi-source node model: visible with the port that actually
// answered (ports vary per machine — nothing may assume the default), merged
// under the broker's record when discovery already knows the host, and
// reconciled away by the next completed round that cannot confirm them.
describe('swept nodes in the bridge state', () => {
    it('shows a swept node with the port that answered, and keeps its telemetry polled', () => {
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-vpn-peer',
            address: '198.51.100.205',
            port: 24318,
            name: 'vpn-box'
        })

        const node = available('uuid-vpn-peer')
        expect(node).toMatchObject({
            id: 'uuid-vpn-peer',
            name: 'vpn-box',
            ipAddress: '198.51.100.205',
            port: 24318,
            clustered: false
        })
        // The sweep's one-shot find hands off to the ordinary node-info poller,
        // so the peer's telemetry stays fresh without another sweep round.
        expect(pollTarget('uuid-vpn-peer')).toEqual({
            id: 'uuid-vpn-peer',
            hosts: ['198.51.100.205'],
            port: 24318
        })
    })

    it('labels a swept node by its address until something names it', () => {
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-unnamed-peer',
            address: '198.51.100.44',
            port: 14318
        })
        expect(available('uuid-unnamed-peer')?.name).toBe('198.51.100.44')
    })

    it('never records this machine, whatever address the VPN routes back to it', () => {
        getModularBridgeState().setSelfId('uuid-self-a')
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-self-a',
            address: '198.51.100.99',
            port: 14318
        })
        expect(isStored('uuid-self-a')).toBe(false)
    })

    it('merges a sweep find into the broker record without flapping the canonical address', () => {
        // Discovery knows the peer on the LAN; the sweep additionally proves it
        // on the VPN. One record, both addresses, broker's identity intact.
        brokerSnapshot([
            { hostUuid: 'uuid-dual-path', name: 'gpu-box', ipAddress: '192.0.2.27', trusted: true }
        ])
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-dual-path',
            address: '198.51.100.205',
            port: 14318
        })

        const nodes = getModularBridgeState()
            .getAvailableNodes()
            .filter(node => node.id === 'uuid-dual-path')
        expect(nodes).toHaveLength(1)
        expect(nodes[0]).toMatchObject({
            name: 'gpu-box',
            ipAddress: '192.0.2.27',
            trusted: true
        })
        // The VPN address is a published alternative: the poller can fail over
        // to it when the LAN path dies.
        expect(nodes[0].ipAddresses).toContain('198.51.100.205')
        expect(pollTarget('uuid-dual-path')?.hosts).toEqual(['192.0.2.27', '198.51.100.205'])
    })

    it('evicts a sweep-only node the next round cannot confirm', () => {
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-vanished',
            address: '198.51.100.61',
            port: 14318
        })
        expect(isStored('uuid-vanished')).toBe(true)

        getModularBridgeState().reconcileSweptNodes(new Set())
        expect(isStored('uuid-vanished')).toBe(false)
        expect(available('uuid-vanished')).toBeUndefined()
    })

    it('keeps a confirmed node across reconcile, with its swept address still published', () => {
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-still-there',
            address: '198.51.100.62',
            port: 14318
        })

        getModularBridgeState().reconcileSweptNodes(new Set(['uuid-still-there']))
        expect(available('uuid-still-there')?.ipAddress).toBe('198.51.100.62')
    })

    it('keeps a broker-known node that loses its sweep confirmation, minus the VPN address', () => {
        brokerSnapshot([{ hostUuid: 'uuid-kept-peer', name: 'kept-box', ipAddress: '192.0.2.27' }])
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-kept-peer',
            address: '198.51.100.205',
            port: 14318
        })

        getModularBridgeState().reconcileSweptNodes(new Set())
        const node = available('uuid-kept-peer')
        expect(node).toMatchObject({ name: 'kept-box', ipAddress: '192.0.2.27' })
        expect(node?.ipAddresses).toBeUndefined()
    })

    it('keeps a sweep-verified peer polled after discovery drops it', () => {
        // The broker snapshot that no longer lists the peer is what mDNS loss
        // looks like: discovery withdraws its record while the VPN path still
        // answers. Zeroing the port here would freeze the peer's telemetry.
        brokerSnapshot([
            { hostUuid: 'uuid-outlived-mdns', name: 'mdns-less', ipAddress: '192.0.2.27' }
        ])
        getModularBridgeState().upsertSweptNode({
            id: 'uuid-outlived-mdns',
            address: '198.51.100.205',
            port: 14318
        })

        brokerSnapshot([])
        const node = available('uuid-outlived-mdns')
        expect(node).toMatchObject({ name: 'mdns-less', ipAddress: '198.51.100.205', port: 14318 })
        expect(pollTarget('uuid-outlived-mdns')).toEqual({
            id: 'uuid-outlived-mdns',
            hosts: ['198.51.100.205'],
            port: 14318
        })
    })
})
