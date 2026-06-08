import { describe, it, expect } from 'vitest';
import { loading, empty, error, unauth } from './states';

describe('honest states', () => {
  it('loading is an accessible busy skeleton grid', () => {
    const html = loading();
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('sk-card');
  });

  it('empty renders the given title + text, escaped', () => {
    const html = empty('No agents yet', 'Connect a platform <first>.');
    expect(html).toContain('No agents yet');
    expect(html).toContain('Connect a platform &lt;first&gt;.');
  });

  it('error renders the message and a retry affordance', () => {
    const html = error('Network unreachable');
    expect(html).toContain('Network unreachable');
    expect(html).toContain('data-act="retry"');
    expect(html).toContain('Something went wrong');
  });

  it('unauth explains the redirect', () => {
    expect(unauth()).toContain('Sign in to continue');
  });
});
