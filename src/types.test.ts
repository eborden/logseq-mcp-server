import { describe, it, expect } from 'vitest';
import type { BlockEntity, PageEntity } from './types.js';

describe('Type Definitions', () => {
  it('should allow valid BlockEntity', () => {
    const block: BlockEntity = {
      id: 1,
      uuid: 'abc-123',
      content: 'test content',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 0 }
    };
    expect(block.uuid).toBe('abc-123');
  });

  it('should allow valid PageEntity', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-123',
      name: 'Test Page',
      originalName: 'Test Page'
    };
    expect(page.name).toBe('Test Page');
  });
});
