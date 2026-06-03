import type { SprintItem } from '@/shared/types/selectionItems';
import type { SelectionPage } from '../SelectionDialog';

export interface SprintSelectionResult {
  sprintId: string | null;
}

export function buildSprintSelectionPages(
  sprints: SprintItem[]
): Record<string, SelectionPage<SprintSelectionResult>> {
  return {
    selectSprint: {
      id: 'selectSprint',
      title: 'Select Sprint',
      buildGroups: () => [
        {
          label: 'Sprint',
          items: [
            // Issue.sprint_id is nullable; the empty-id item clears it (M1 #107).
            { type: 'sprint' as const, sprint: { id: '', name: 'No sprint' } },
            ...sprints.map((s) => ({ type: 'sprint' as const, sprint: s })),
          ],
        },
      ],
      onSelect: (item) => {
        if (item.type === 'sprint') {
          return {
            type: 'complete',
            data: { sprintId: item.sprint.id === '' ? null : item.sprint.id },
          };
        }
        return { type: 'complete', data: undefined as never };
      },
    },
  };
}
