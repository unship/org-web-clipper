import { describe, it, expect } from 'vitest';
import { propertiesToOrgDrawer } from './org-note-creator';
import type { Property } from '../types/types';

const p = (name: string, value: string, type = 'text'): Property => ({ name, value, type } as Property);

describe('propertiesToOrgDrawer', () => {
  it('renders scalar properties into a drawer', () => {
    expect(propertiesToOrgDrawer([p('author', 'Jane'), p('source', 'https://x')]))
      .toBe(':PROPERTIES:\n:AUTHOR: Jane\n:SOURCE: https://x\n:END:');
  });
  it('joins multitext values with commas', () => {
    expect(propertiesToOrgDrawer([{ name: 'tags', value: 'a, b', type: 'multitext' } as Property]))
      .toBe(':PROPERTIES:\n:TAGS: a, b\n:END:');
  });
  it('skips empty values and returns empty string for no properties', () => {
    expect(propertiesToOrgDrawer([])).toBe('');
    expect(propertiesToOrgDrawer([p('empty', '')])).toBe('');
  });
  it('upcases and sanitises keys to valid drawer keys', () => {
    expect(propertiesToOrgDrawer([p('Created At', '2026-06-06')]))
      .toBe(':PROPERTIES:\n:CREATED_AT: 2026-06-06\n:END:');
  });
});
