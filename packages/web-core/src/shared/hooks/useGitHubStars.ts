import { useQuery } from '@tanstack/react-query';

// Egress severed: this fork does not poll the upstream GitHub repo for a star
// count. Returns null (no outbound request).
async function fetchGitHubStars(): Promise<number | null> {
  return null;
}

export function useGitHubStars() {
  return useQuery({
    queryKey: ['github-stars'],
    queryFn: fetchGitHubStars,
    refetchInterval: 10 * 60 * 1000,
    staleTime: 10 * 60 * 1000,
    retry: false,
    refetchOnMount: false,
    placeholderData: (previousData) => previousData,
  });
}
