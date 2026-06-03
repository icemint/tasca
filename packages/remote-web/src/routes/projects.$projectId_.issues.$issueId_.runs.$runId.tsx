import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { RunViewPage } from "@/pages/runs/RunViewPage";

export const Route = createFileRoute(
  "/projects/$projectId_/issues/$issueId_/runs/$runId",
)({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: RunViewPage,
});
