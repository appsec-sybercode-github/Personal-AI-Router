// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, Divider, Flex, Stack, Text } from '@nvidia/foundations-react-core'
import type { AvailableNode } from '@/shared/types/cluster'

interface DiscoveredNodesSectionProps {
    /** Discovered peers that are neither cluster members nor this machine. */
    peers: AvailableNode[]
    /** Open the Add Node modal and start inviting the peer at this address. */
    onAdd: (address: string) => void
}

/**
 * Discovered PAIR nodes on the networks this machine can reach — mDNS peers the
 * broker carries, plus whatever the subnet sweep verified (see
 * network-sweep.ts). Rendered below the member cards in the Overview node
 * column; hidden entirely when there is nothing to invite.
 *
 * The rows deliberately carry no `data-node-id` / `data-workload-id`: those
 * attributes are the workload connector lines' anchors and belong to member
 * cards only (NodeCardDetails), and a discovered peer never runs workloads.
 * No `node-card` / `pair-paper` either — member cards stay visually primary.
 */
export function DiscoveredNodesSection({ peers, onAdd }: DiscoveredNodesSectionProps) {
    if (peers.length === 0) return null

    return (
        <Stack gap="2" className="pt-2">
            <Divider />
            <Text kind="body/semibold/xs" className="text-subtle-color uppercase">
                Discovered nodes
            </Text>
            <Stack gap="1">
                {peers.map(node => (
                    <Flex key={node.id} align="center" justify="between" gap="2" className="py-1">
                        <Stack gap="0" className="min-w-0">
                            <Text kind="body/semibold/sm" className="uppercase truncate">
                                {node.name || node.ipAddress}
                            </Text>
                            <Text kind="body/regular/sm" className="text-subtle-color truncate">
                                {node.clustered
                                    ? 'In another cluster'
                                    : `${node.ipAddress}:${node.port}`}
                            </Text>
                        </Stack>
                        <Button
                            kind="primary"
                            color="brand"
                            size="small"
                            onClick={() => onAdd(node.ipAddress)}
                            // A node already in a cluster cannot join another;
                            // the backend would reject the invite
                            // (`rejected` / `already-clustered`).
                            disabled={node.clustered}
                        >
                            Add
                        </Button>
                    </Flex>
                ))}
            </Stack>
        </Stack>
    )
}

export default DiscoveredNodesSection
