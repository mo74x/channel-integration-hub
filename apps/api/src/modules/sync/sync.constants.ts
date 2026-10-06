export const SYNC_QUEUES = {
  OUTBOUND_INVENTORY: 'outbound-inventory-sync',
  POLLING_RESERVATIONS: 'polling-reservations-sync',
  RECONCILIATION: 'reconciliation-sync',
} as const;

export const SYNC_JOBS = {
  PUSH_INVENTORY_SLOT: 'push-inventory-slot',
  POLL_PARTNER_RESERVATIONS: 'poll-partner-reservations',
  RUN_RECONCILIATION: 'run-reconciliation',
} as const;