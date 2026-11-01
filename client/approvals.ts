import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { approvalListRpc } from "../shared/rpc";

export const approvalsQueryKey = ["aydo", "approvals"];

/** Every approval, newest first, with how many wait for the user. Refreshed every few seconds: a bot may ask at any time. */
export function useApprovals() {
  const list = useRpc(approvalListRpc);
  return useQuery({ queryKey: approvalsQueryKey, queryFn: () => list({}), refetchInterval: 10_000 });
}
