import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Label } from '@vibe/ui/components/Label';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal, type NoProps } from '@/shared/lib/modals';

/**
 * Link-a-pull-request dialog — SCAFFOLD (flag.github_pr).
 *
 * Stub UI per the plan: the actual link is performed by the M4 webhook linker,
 * so this collects a URL but performs NO GitHub API call or mutation. The link
 * action is intentionally inert (disabled) until M4; the dialog only resolves
 * (closes). It never fabricates a linked PR.
 */
const PrLinkModalImpl = create<NoProps>(() => {
  const modal = useModal();
  const [url, setUrl] = useState('');

  const close = () => modal.resolve();

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link a pull request</DialogTitle>
          <DialogDescription>
            Paste a pull-request URL to associate it with this issue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="pr-link-url" className="text-fg-2">
            Pull request URL
          </Label>
          <Input
            id="pr-link-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/org/repo/pull/123"
          />
          <p className="text-xs text-fg-3">
            Linking activates with the GitHub integration — coming soon.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled
            title="Available with the GitHub integration"
            aria-disabled="true"
          >
            Link pull request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const PrLinkModal = defineModal<void, void>(PrLinkModalImpl);
