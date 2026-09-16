// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse a user-supplied port list (comma or space separated) into valid,
 * de-duplicated sweep port candidates, first 8 only. Shared by the main-process
 * sweep (network-sweep.ts) and the Settings input that edits the list, so the
 * two can never disagree about what a valid entry is.
 *
 * Empty input yields the empty list — callers decide what that means.
 */
export function parseSweepPortList(raw: string): number[] {
    const ports: number[] = []
    for (const token of raw.split(/[\s,]+/)) {
        const trimmed = token.trim()
        if (!trimmed) continue
        const port = Number(trimmed)
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue
        if (ports.includes(port)) continue
        ports.push(port)
        if (ports.length >= 8) break
    }
    return ports
}
