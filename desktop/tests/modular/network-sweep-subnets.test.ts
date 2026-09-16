// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'

// Importing network-sweep pulls the main-process modules around it; the pure
// policy functions under test here need none of them, so the heavy imports are
// stubbed away and only the subnet math runs.
vi.mock('@/electron/service-bridge/modular-state', () => ({
    getModularBridgeState: () => {
        throw new Error('the subnet policy must not touch bridge state')
    }
}))
vi.mock('@/electron/config/ui-config', () => ({
    isNetworkSweepEnabled: () => true,
    getNetworkSweepPorts: () => [14318]
}))
vi.mock('@/shared/utils/log', () => ({
    createStructuredLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        verbose: vi.fn()
    })
}))

import * as os from 'os'
import {
    ipv4InterfaceCandidates,
    sweepTargetsFrom,
    type InterfaceCandidate
} from '@/electron/service-bridge/network-sweep'
import { parseSweepPortList } from '@/shared/utils/sweep-ports'

/** One IPv4 interface entry, in the shape os.networkInterfaces() reports. */
function iface(
    address: string,
    netmask: string,
    options: { internal?: boolean; cidr?: string | null } = {}
): os.NetworkInterfaceInfo {
    return {
        family: 'IPv4',
        address,
        netmask,
        mac: '00:00:00:00:00:00',
        // POSIX reports cidr, Windows does not — both paths must produce a prefix.
        cidr: options.cidr === undefined ? `${address}/${netmaskToPrefix(netmask)}` : options.cidr,
        internal: options.internal ?? false,
        scopeid: 0
    } as os.NetworkInterfaceInfo
}

function netmaskToPrefix(netmask: string): number {
    const ones = netmask
        .split('.')
        .map(Number)
        .reduce((acc, octet) => acc + ((octet >>> 0).toString(2).match(/1/g)?.length ?? 0), 0)
    return ones
}

function candidate(name: string, address: string, prefix: number): InterfaceCandidate {
    return { name, address, prefix }
}

function hostsOf(targets: { hosts: string[] }[]): string[] {
    return targets.flatMap(target => target.hosts)
}

// Which subnets a sweep round may probe. VPN adapters are the entire point —
// an OpenVPN tun carries no mDNS, so the sweep is the only discovery there —
// while host-only bridges lead to this machine's own containers, and wider
// prefixes must be capped so one /16 interface cannot cost 65k connects.
describe('sweep subnet policy', () => {
    it('sweeps real and VPN adapters, but not host-only virtual ones', () => {
        const candidates = ipv4InterfaceCandidates({
            en0: [iface('192.0.2.8', '255.255.255.0')],
            utun3: [iface('198.51.100.8', '255.255.255.0')],
            docker0: [iface('172.17.0.1', '255.255.0.0')],
            veth9f3a2b1: [iface('172.18.0.1', '255.255.0.0')],
            'vEthernet (WSL)': [iface('172.22.16.1', '255.255.240.0')],
            vmnet8: [iface('192.168.73.1', '255.255.255.0')],
            lo0: [iface('127.0.0.1', '255.0.0.0', { internal: true })]
        })

        // Every adapter a remote PAIR peer can sit behind stays; the interfaces
        // whose neighbors are containers or VMs on this machine go.
        expect(candidates).toEqual([
            candidate('en0', '192.0.2.8', 24),
            candidate('utun3', '198.51.100.8', 24)
        ])
    })

    it('keeps a link-local adapter out of the plan', () => {
        expect(
            ipv4InterfaceCandidates({
                en0: [iface('192.0.2.8', '255.255.255.0')],
                awdl0: [iface('169.254.42.10', '255.255.255.0')]
            })
        ).toEqual([candidate('en0', '192.0.2.8', 24)])
    })

    it('derives the prefix from the netmask when the OS reports no cidr', () => {
        // Windows NetworkInterfaceInfo carries no cidr field.
        const windowsStyle = ipv4InterfaceCandidates({
            'OpenVPN TAP-Windows6': [iface('198.51.100.8', '255.255.255.0', { cidr: null })]
        })
        expect(windowsStyle).toEqual([candidate('OpenVPN TAP-Windows6', '198.51.100.8', 24)])
    })

    it("caps a wide VPN prefix at this machine's own /24 window", () => {
        const targets = sweepTargetsFrom(
            [candidate('utun9', '198.18.140.8', 16)],
            new Set(['198.18.140.8'])
        )
        expect(targets).toHaveLength(1)
        expect(targets[0].subnetAddress).toBe('198.18.140.0')
        expect(targets[0].prefix).toBe(24)
        // Every address of the /24 except network, broadcast, and this machine.
        expect(targets[0].hosts).toHaveLength(253)
        expect(targets[0].hosts[0]).toBe('198.18.140.1')
        expect(targets[0].hosts.at(-1)).toBe('198.18.140.254')
        expect(targets[0].hosts).not.toContain('198.18.140.8')
    })

    it('sweeps a /24 whole, minus its network, broadcast, and local addresses', () => {
        const targets = sweepTargetsFrom(
            [candidate('en0', '192.0.2.10', 24)],
            new Set(['192.0.2.10', '192.0.2.77'])
        )
        expect(targets).toHaveLength(1)
        const hosts = targets[0].hosts
        expect(hosts).not.toContain('192.0.2.0')
        expect(hosts).not.toContain('192.0.2.255')
        expect(hosts).not.toContain('192.0.2.10')
        // An address another adapter of this machine holds, even one the sweep
        // does not probe from: probing ourselves is noise at best.
        expect(hosts).not.toContain('192.0.2.77')
        expect(hosts).toHaveLength(252)
    })

    it('probes two adapters on the same subnet once, not twice', () => {
        const targets = sweepTargetsFrom(
            [candidate('en0', '192.0.2.8', 24), candidate('en1', '192.0.2.9', 24)],
            new Set(['192.0.2.8', '192.0.2.9'])
        )
        expect(targets).toHaveLength(1)
        expect(targets[0].hosts).toHaveLength(252)
    })

    it('skips point-to-point prefixes, which have no neighbors to sweep', () => {
        // These are still candidates — a /32 has a usable prefix — but no
        // address window comes out of them.
        expect(sweepTargetsFrom([candidate('utun0', '100.72.5.6', 32)], new Set())).toEqual([])
        expect(sweepTargetsFrom([candidate('gif0', '10.1.2.4', 31)], new Set())).toEqual([])
    })

    it('keeps separate windows for the LAN and the VPN side by side', () => {
        const targets = sweepTargetsFrom(
            [candidate('en0', '192.0.2.8', 24), candidate('utun3', '198.51.100.8', 24)],
            new Set(['192.0.2.8', '198.51.100.8'])
        )
        expect(targets.map(target => `${target.subnetAddress}/${target.prefix}`)).toEqual([
            '192.0.2.0/24',
            '198.51.100.0/24'
        ])
        expect(hostsOf(targets)).toHaveLength(506)
    })
})

// The port list is user-entered free text in Settings; the parse is what keeps
// garbage out of the probe plan without rejecting the whole field.
describe('parseSweepPortList', () => {
    it('accepts commas and spaces, and drops repeats', () => {
        expect(parseSweepPortList('14318, 24318 14318')).toEqual([14318, 24318])
    })

    it('drops anything that is not a usable TCP port', () => {
        expect(parseSweepPortList('14318, abc, 0, 70000, -1, 14318.5')).toEqual([14318])
        expect(parseSweepPortList('no ports here')).toEqual([])
        expect(parseSweepPortList('')).toEqual([])
    })

    it('caps the list at eight ports', () => {
        const nine = Array.from({ length: 9 }, (_, index) => String(20000 + index)).join(', ')
        expect(parseSweepPortList(nine)).toHaveLength(8)
        expect(parseSweepPortList(nine)[0]).toBe(20000)
    })
})
