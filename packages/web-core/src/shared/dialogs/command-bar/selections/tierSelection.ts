import type { ComplexityTier } from 'shared/remote-types';
import type { TierItem } from '@/shared/types/selectionItems';
import type { SelectionPage } from '../SelectionDialog';

export interface TierSelectionResult {
  complexityTier: ComplexityTier;
}

// Complexity tier is non-nullable on Issue, so (unlike priority) there is no
// "No tier" option — exactly the 5 enum values (M1 #105).
const TIER_ITEMS: TierItem[] = [
  { id: 'basic', name: 'Basic' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'hard', name: 'Hard' },
  { id: 'ultra', name: 'Ultra' },
];

export function buildTierSelectionPages(): Record<
  string,
  SelectionPage<TierSelectionResult>
> {
  return {
    selectTier: {
      id: 'selectTier',
      title: 'Select Tier',
      buildGroups: () => [
        {
          label: 'Tier',
          items: TIER_ITEMS.map((tier) => ({
            type: 'tier' as const,
            tier,
          })),
        },
      ],
      onSelect: (item) => {
        if (item.type === 'tier') {
          return {
            type: 'complete',
            data: { complexityTier: item.tier.id },
          };
        }
        return { type: 'complete', data: undefined as never };
      },
    },
  };
}
