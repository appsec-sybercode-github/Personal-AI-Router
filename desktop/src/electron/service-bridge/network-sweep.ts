// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as net from 'net'
import * as os from 'os'
import { getModularBridgeState } from './modular-state'
import { fetchNodeInfo } from './node-info-poller'
import { isNetworkSweepEnabled, getNetworkSweepPorts } from '@/electron/config/ui-config'
import { createStructuredLogger } from '@/shared/utils/log'
import {
    MODULAR_NETWORK_SWEEP_CONCURRENCY,
    MODULAR_NETWORK_SWEEP_CONNECT_TIMEOUT_MS,
    MODULAR_NETWORK_SWEEP_INTERFACE_DEBOUNCE_MS,
    MODULAR_NETWORK_SWEEP_INTERFACE_WATCH_MS,
    MODULAR_NETWORK_SWEEP_INTERVAL_MS,
    MODULAR_NETWORK_SWEEP_MIN_GAP_MS,
    MODULAR_NETWORK_SWEEP_STARTUP_DELAY_MS
} from '@/shared/constants/modular-runtime'

const log = createStructuredLogger('service-bridge')

/**
 * Why a sweep round is running. `'interface-change'` rounds are debounced and
 * gap-limited; startup and interval rounds always run.
 */
export type SweepReason = 'startup' | 'interval' | 'interface-change'

/**
 * Virtual host-only adapters, by name. Deliberately narrow: it must never match
 * a VPN adapter (`utun*`, `tun*`, `tap*`, `Tailscale`) — those are the entire
 * point of the sweep. It only prunes host-local bridges whose "neighbors" are
 * containers or VMs on this machine, not PAIR peers.
 */
const VIRTUAL_ADAPTER_PATTERN = /^(docker|br-|veth|virbr|vmnet|bridge|vEthernet|Loopback Pseudo)/i

export interface InterfaceCandidate {
    name: string
    address: string
    /** Prefix length 0–32. */
    prefix: number
}

export interface SweepTarget {
    /** Network address of the window actually probed. */
    subnetAddress: string
    /** Prefix of the window actually probed (the subnet's, or /24 when capped). */
    prefix: number
    hosts: string[]
}

/** IPv4 dotted quad to uint32, or null when malformed. */
function ipv4ToInt(address: string): number | null {
    const parts = address.split('.')
    if (parts.length !== 4) return null
    let value = 0
    for (const part of parts) {
        const octet = Number(part)
        if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
        value = value * 256 + octet
    }
    return value
}

/** uint32 to IPv4 dotted quad. */
function intToIpv4(value: number): string {
    return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

/** Dotted-quad netmask to prefix length, or null when malformed. */
function maskToPrefix(netmask: string): number | null {
    const mask = ipv4ToInt(netmask)
    if (mask === null) return null
    // A valid netmask is leading ones followed by zeros; count the ones and
    // verify nothing follows them.
    let prefix = 0
    let rest = mask >>> 0
    while (rest & 0x80000000) {
        prefix += 1
        rest = (rest << 1) >>> 0
    }
    if (rest !== 0) return null
    return prefix
}

/**
 * Every IPv4 interface the sweep may probe: non-internal, non-link-local, not a
 * known virtual host adapter, with a usable prefix (from `cidr` where POSIX
 * provides it, else counted from the netmask Windows provides).
 */
export function ipv4InterfaceCandidates(
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>
): InterfaceCandidate[] {
    const candidates: InterfaceCandidate[] = []
    for (const [name, entries] of Object.entries(interfaces)) {
        if (!entries || VIRTUAL_ADAPTER_PATTERN.test(name)) continue
        for (const info of entries) {
            if (info.family !== 'IPv4') continue
            if (info.internal) continue
            if (info.address.startsWith('169.254.')) continue
            let prefix: number | null = null
            if (info.cidr) {
                const parsed = info.cidr.split('/')[1]
                const value = Number(parsed)
                prefix = Number.isInteger(value) && value >= 0 && value <= 32 ? value : null
            }
            if (prefix === null) prefix = info.netmask ? maskToPrefix(info.netmask) : null
            if (prefix === null) continue
            candidates.push({ name, address: info.address, prefix })
        }
    }
    return candidates
}

/** Every IPv4 address on this machine, across all interfaces (internal included). */
function localIpv4Addresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): Set<string> {
    const addresses = new Set<string>()
    for (const entries of Object.values(interfaces)) {
        for (const info of entries ?? []) {
            if (info.family === 'IPv4') addresses.add(info.address)
        }
    }
    return addresses
}

/**
 * The probe plan: for each interface, the address window to sweep.
 *
 * Prefixes ≥ /24 are swept whole (≤ 254 hosts). A wider prefix (a /16 or /20
 * VPN) is capped at this machine's own /24 window — 65k connect attempts per
 * round is minutes of noise for no discovery gain on a user subnet.
 * Point-to-point prefixes (≥ /31, e.g. Tailscale's /32) have no neighbors and
 * are skipped. Network, broadcast, and every local address are excluded;
 * overlapping windows reported by two interfaces are probed once.
 */
export function sweepTargetsFrom(
    candidates: readonly InterfaceCandidate[],
    localAddresses: ReadonlySet<string>
): SweepTarget[] {
    const bySubnet = new Map<string, SweepTarget>()
    for (const candidate of candidates) {
        const address = ipv4ToInt(candidate.address)
        if (address === null || candidate.prefix >= 31) continue
        const prefix = Math.max(candidate.prefix, 24)
        const size = 2 ** (32 - prefix)
        const base = (address & (0xffffffff << (32 - prefix))) >>> 0
        const key = `${intToIpv4(base)}/${prefix}`
        if (bySubnet.has(key)) continue
        const hosts: string[] = []
        for (let offset = 1; offset < size - 1; offset += 1) {
            const host = intToIpv4(base + offset)
            if (localAddresses.has(host)) continue
            hosts.push(host)
        }
        if (hosts.length === 0) continue
        bySubnet.set(key, { subnetAddress: intToIpv4(base), prefix, hosts })
    }
    return Array.from(bySubnet.values())
}

/**
 * Parse a user-supplied port list into sweep port candidates. Defined in
 * `@/shared/utils/sweep-ports` (shared with the Settings input) and re-exported
 * here for the tests that exercise the sweep's pure surface.
 */
export { parseSweepPortList } from '@/shared/utils/sweep-ports'

/** A stable signature of the machine's non-internal IPv4 addresses. */
function interfaceSignature(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string {
    const parts: string[] = []
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const info of entries ?? []) {
            if (info.family !== 'IPv4') continue
            if (info.internal) continue
            parts.push(`${name}:${info.address}`)
        }
    }
    return parts.sort().join('|')
}

/**
 * One TCP connect attempt, strictly bounded. Resolves false on timeout, error,
 * or abort — never rejects; a dead host is an answer, not a failure.
 */
function tcpConnect(
    host: string,
    port: number,
    timeoutMs: number,
    signal: AbortSignal
): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    return new Promise(resolve => {
        const socket = new net.Socket()
        let settled = false
        const finish = (connected: boolean): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            resolve(connected)
        }
        const timer = setTimeout(() => finish(false), timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
        signal.addEventListener('abort', () => finish(false), { once: true })
        socket.connect(port, host)
    })
}

/** `hostUuid` from a node-info payload, when it is a usable string. */
function hostUuidOf(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
    const value = (payload as { hostUuid?: unknown }).hostUuid
    return typeof value === 'string' ? value : ''
}

/** Optional display name from a node-info payload. */
function nameOf(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const value = (payload as { name?: unknown }).name
    return typeof value === 'string' && value ? value : undefined
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function runWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    let index = 0
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const item = items[index]
            index += 1
            await worker(item)
        }
    })
    await Promise.all(runners)
}

let intervalTimer: ReturnType<typeof setInterval> | null = null
let watchTimer: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let startupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Aborted by {@link stopNetworkSweep}: a round already mid-probe has its
 * results disowned — no upserts, and crucially no reconcile, so stopping mid-
 * sweep never evicts nodes on incomplete evidence.
 */
let currentRun: AbortController | null = null
let roundInFlight = false
let lastRoundAt = 0
let lastSignature = ''

/** Start the sweep loop. Idempotent; safe to call before the config is loaded. */
export function startNetworkSweep(): void {
    if (intervalTimer) return
    lastSignature = ''
    startupTimer = setTimeout(() => {
        startupTimer = null
        void sweepNetworkOnce('startup')
    }, MODULAR_NETWORK_SWEEP_STARTUP_DELAY_MS)
    intervalTimer = setInterval(() => {
        void sweepNetworkOnce('interval')
    }, MODULAR_NETWORK_SWEEP_INTERVAL_MS)
    watchTimer = setInterval(watchInterfaces, MODULAR_NETWORK_SWEEP_INTERFACE_WATCH_MS)
}

/**
 * Stop the sweep loop and abort any round in flight.
 * `dropSweptNodes` also reconciles with an empty confirmation set, so nodes the
 * sweep had contributed disappear deterministically instead of at the next
 * round's evidence.
 */
export function stopNetworkSweep(options?: { dropSweptNodes?: boolean }): void {
    if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
    }
    if (intervalTimer) {
        clearInterval(intervalTimer)
        intervalTimer = null
    }
    if (watchTimer) {
        clearInterval(watchTimer)
        watchTimer = null
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
    }
    currentRun?.abort()
    currentRun = null
    lastSignature = ''
    if (options?.dropSweptNodes) getModularBridgeState().reconcileSweptNodes(new Set())
}

/** Watch for a VPN interface arriving or leaving and sweep shortly after. */
function watchInterfaces(): void {
    const signature = interfaceSignature(os.networkInterfaces())
    if (lastSignature === '') {
        lastSignature = signature
        return
    }
    if (signature === lastSignature) return
    lastSignature = signature
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
        debounceTimer = null
        // A reconnecting VPN flaps its interface; the min gap keeps one change
        // from costing a round per bounce.
        if (Date.now() - lastRoundAt < MODULAR_NETWORK_SWEEP_MIN_GAP_MS) return
        void sweepNetworkOnce('interface-change')
    }, MODULAR_NETWORK_SWEEP_INTERFACE_DEBOUNCE_MS)
}

/**
 * One sweep round, whatever its trigger. Only one runs at a time; a tick while
 * a round is live is skipped. When the sweep is disabled the loop tears itself
 * down and any swept nodes are dropped.
 */
export async function sweepNetworkOnce(reason: SweepReason): Promise<void> {
    if (roundInFlight) return
    if (!isNetworkSweepEnabled()) {
        if (intervalTimer) {
            stopNetworkSweep()
        }
        getModularBridgeState().reconcileSweptNodes(new Set())
        return
    }
    roundInFlight = true
    const run = new AbortController()
    currentRun = run
    try {
        await runRound(run, reason)
    } finally {
        roundInFlight = false
        if (currentRun === run) currentRun = null
    }
}

async function runRound(run: AbortController, reason: SweepReason): Promise<void> {
    lastRoundAt = Date.now()
    const interfaces = os.networkInterfaces()
    const targets = sweepTargetsFrom(
        ipv4InterfaceCandidates(interfaces),
        localIpv4Addresses(interfaces)
    )
    const ports = getNetworkSweepPorts()
    const probes: { host: string; port: number }[] = []
    for (const target of targets) {
        for (const port of ports) {
            for (const host of target.hosts) probes.push({ host, port })
        }
    }

    // No interface to sweep (network down, or only filtered adapters): swept
    // nodes from an earlier round can no longer be confirmed — drop them.
    if (probes.length === 0) {
        getModularBridgeState().reconcileSweptNodes(new Set())
        return
    }

    log.info({
        sublevel: 'network-sweep',
        message: 'Sweeping subnets for PAIR nodes',
        data: {
            reason,
            subnets: targets.map(target => `${target.subnetAddress}/${target.prefix}`),
            ports,
            probes: probes.length
        }
    })

    const state = getModularBridgeState()
    const selfId = state.getSelfId()
    const confirmed = new Set<string>()
    const found: { id: string; address: string }[] = []

    await runWithConcurrency(probes, MODULAR_NETWORK_SWEEP_CONCURRENCY, async ({ host, port }) => {
        if (run.signal.aborted) return
        const connected = await tcpConnect(
            host,
            port,
            MODULAR_NETWORK_SWEEP_CONNECT_TIMEOUT_MS,
            run.signal
        )
        if (!connected || run.signal.aborted) return
        const probe = await fetchNodeInfo(host, port, run.signal)
        if (run.signal.aborted || !probe.parsed) return
        const id = hostUuidOf(probe.parsed)
        // Without a hostUuid the answer cannot be keyed to a node; without a
        // self guard, a NAT'd VPN routing our own address back to us would
        // merge foreign-path telemetry into the self record.
        if (!id || id === selfId) return
        state.upsertSweptNode({ id, address: host, port, name: nameOf(probe.parsed) })
        state.mergeNodeInfoResponse(id, probe.parsed)
        confirmed.add(id)
        found.push({ id, address: host })
    })

    // An aborted round is not evidence: reconcile nothing, evict nothing.
    if (run.signal.aborted) return
    state.reconcileSweptNodes(confirmed)
    if (found.length > 0) {
        log.info({
            sublevel: 'network-sweep',
            message: `Subnet sweep found ${found.length} PAIR node(s)`,
            data: { reason, nodes: found }
        })
    }
}
