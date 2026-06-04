import { useCallback, useMemo } from 'react';
import type { ApprovalInfo } from 'shared/types';
import { useJsonPatchWsStream } from './useJsonPatchWsStream';
import { useHostId } from '@/shared/providers/HostIdProvider';

interface UseApprovalsResult {
  pendingApprovals: ApprovalInfo[];
  getPendingForProcess: (executionProcessId: string) => ApprovalInfo | null;
  getPendingById: (approvalId: string) => ApprovalInfo | null;
  isConnected: boolean;
}

type ApprovalState = {
  pending: Record<string, ApprovalInfo>;
};

export function useApprovals(): UseApprovalsResult {
  // #181: host-scoped WS — gate on a connected host so the no-host state doesn't
  // storm the relay with "Host context is required" reconnects.
  const hostId = useHostId();
  const { data, isConnected } = useJsonPatchWsStream<ApprovalState>(
    '/api/approvals/stream/ws',
    !!hostId,
    () => ({ pending: {} })
  );

  const pendingById = useMemo(() => data?.pending ?? {}, [data?.pending]);
  const pendingApprovals = useMemo(
    () => Object.values(pendingById),
    [pendingById]
  );

  const getPendingForProcess = useCallback(
    (executionProcessId: string): ApprovalInfo | null => {
      for (const info of pendingApprovals) {
        if (info.execution_process_id === executionProcessId) {
          return info;
        }
      }
      return null;
    },
    [pendingApprovals]
  );

  const getPendingById = useCallback(
    (approvalId: string): ApprovalInfo | null => {
      return pendingById[approvalId] ?? null;
    },
    [pendingById]
  );

  return {
    pendingApprovals,
    getPendingForProcess,
    getPendingById,
    isConnected,
  };
}
