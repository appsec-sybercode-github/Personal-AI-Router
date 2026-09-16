// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs'
import path from 'path'
import { getPaths } from '@/electron/globals'
import {
    MODULAR_DEFAULT_LOG_LEVEL,
    MODULAR_NODE_INFO_DEFAULT_PORT,
    isModularLogLevel,
    type ModularLogLevel
} from '@/shared/constants/modular-runtime'

interface UiConfig {
    /** When true, first-run onboarding has not been completed or explicitly dismissed. */
    firstRun: boolean
    /** Log level passed to every backend binary (`--log-level` at spawn + live `log/set-level`). Authoritative source for the modular log level. */
    modularLogLevel: ModularLogLevel
    /** macOS only: the one-time privileged-helper setup (register the SMAppService daemon + configure the Application Firewall) has completed. Gates the first-run admin prompt; left false until the daemon is enabled and firewall configuration succeeds, so an approval-pending launch retries next time. */
    macHelperSetupComplete: boolean
    /** Whether the automatic subnet sweep (network-sweep.ts) runs: probing each non-virtual IPv4 interface's subnet for PAIR's node-info service, which is what makes peers on multicast-less networks (OpenVPN tun, WireGuard) discoverable. */
    networkSweepEnabled: boolean
    /** Node-info port candidates for the sweep. The default covers every unmodified install; a node moved off the default port is found by listing the port here. */
    networkSweepPorts: number[]
}

const DEFAULTS: UiConfig = {
    firstRun: true,
    modularLogLevel: MODULAR_DEFAULT_LOG_LEVEL,
    macHelperSetupComplete: false,
    networkSweepEnabled: true,
    networkSweepPorts: [MODULAR_NODE_INFO_DEFAULT_PORT]
}

/** Valid, de-duplicated sweep port candidates, first 8 only. */
function sanitizeSweepPorts(ports: unknown): number[] | null {
    if (!Array.isArray(ports)) return null
    const out: number[] = []
    for (const entry of ports) {
        const port = typeof entry === 'number' ? entry : Number(entry)
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue
        if (out.includes(port)) continue
        out.push(port)
        if (out.length >= 8) break
    }
    return out.length > 0 ? out : null
}

let config: UiConfig = { ...DEFAULTS }
let configFilePath = ''

/** Same directory as `service-config.json` (see `initConfigStore` in file-config-store). */
function getFilePath(): string {
    if (!configFilePath) {
        configFilePath = path.join(getPaths().getUserData(), 'configs', 'ui-config.json')
    }
    return configFilePath
}

function getLegacyFilePath(): string {
    return path.join(getPaths().getUserData(), 'ui-config.json')
}

export function loadUiConfig(): void {
    try {
        const filePath = getFilePath()
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8')
            const parsed = JSON.parse(raw)
            const merged = { ...DEFAULTS, ...parsed } as UiConfig
            let migrated = false
            if (!('firstRun' in parsed)) {
                merged.firstRun = false
                migrated = true
            }
            config = merged
            if (migrated) save()
        } else {
            const legacy = getLegacyFilePath()
            if (fs.existsSync(legacy)) {
                const raw = fs.readFileSync(legacy, 'utf8')
                const parsed = JSON.parse(raw)
                const merged = { ...DEFAULTS, ...parsed } as UiConfig
                if (!('firstRun' in parsed)) {
                    merged.firstRun = false
                }
                config = merged
                save()
                try {
                    fs.unlinkSync(legacy)
                } catch {
                    /* best-effort remove after migrate */
                }
            }
        }
    } catch {
        config = { ...DEFAULTS }
    }
}

function save(): void {
    try {
        const filePath = getFilePath()
        const dir = path.dirname(filePath)
        fs.mkdirSync(dir, { recursive: true })
        const tmp = filePath + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
        fs.renameSync(tmp, filePath)
    } catch {
        /* best-effort */
    }
}

export function isFirstRun(): boolean {
    return config.firstRun
}

/** Persist that first-run onboarding completed or was explicitly dismissed. */
export function completeFirstRun(): void {
    if (!config.firstRun) return
    config.firstRun = false
    save()
}

export function getModularLogLevel(): ModularLogLevel {
    // Guard against a hand-edited / legacy config value that isn't a valid level.
    return isModularLogLevel(config.modularLogLevel)
        ? config.modularLogLevel
        : MODULAR_DEFAULT_LOG_LEVEL
}

export function setModularLogLevel(value: ModularLogLevel): void {
    config.modularLogLevel = value
    save()
}

export function isMacHelperSetupComplete(): boolean {
    return config.macHelperSetupComplete === true
}

export function setMacHelperSetupComplete(value: boolean): void {
    config.macHelperSetupComplete = value
    save()
}

export function isNetworkSweepEnabled(): boolean {
    return config.networkSweepEnabled !== false
}

export function setNetworkSweepEnabled(value: boolean): void {
    config.networkSweepEnabled = value
    save()
}

export function getNetworkSweepPorts(): number[] {
    // Guard against a hand-edited / legacy config value, same as the log level.
    return sanitizeSweepPorts(config.networkSweepPorts) ?? [...DEFAULTS.networkSweepPorts]
}

export function setNetworkSweepPorts(ports: number[]): void {
    config.networkSweepPorts = sanitizeSweepPorts(ports) ?? [...DEFAULTS.networkSweepPorts]
    save()
}
