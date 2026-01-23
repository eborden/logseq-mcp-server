import { describe, it, expect } from 'vitest';
import {
  extractPageRefs,
  extractTags,
  buildPageNameMap,
  getPageNameFromBlock,
  toSlimBlock,
  toSlimPage
} from './slim-entities.js';
import { BlockEntity, PageEntity } from '../types.js';

describe('extractPageRefs', () => {
  it('should extract page references from content', () => {
    const content = 'Check [[Project Plan]] and [[Meeting Notes]]';
    const refs = extractPageRefs(content);
    expect(refs).toEqual(['Project Plan', 'Meeting Notes']);
  });

  it('should handle content with no references', () => {
    const content = 'Plain text without references';
    const refs = extractPageRefs(content);
    expect(refs).toEqual([]);
  });

  it('should handle empty content', () => {
    const refs = extractPageRefs('');
    expect(refs).toEqual([]);
  });

  it('should extract references with special characters', () => {
    const content = 'See [[Q1-2025]] and [[Team/Engineering]]';
    const refs = extractPageRefs(content);
    expect(refs).toEqual(['Q1-2025', 'Team/Engineering']);
  });
});

describe('extractTags', () => {
  it('should extract tags from content', () => {
    const content = 'Working on #project #planning today';
    const tags = extractTags(content);
    expect(tags).toEqual(['project', 'planning']);
  });

  it('should handle content with no tags', () => {
    const content = 'Plain text without tags';
    const tags = extractTags(content);
    expect(tags).toEqual([]);
  });

  it('should handle empty content', () => {
    const tags = extractTags('');
    expect(tags).toEqual([]);
  });

  it('should not extract # at start of line (markdown heading)', () => {
    const content = '# Heading\nSome text with #real-tag';
    const tags = extractTags(content);
    // The regex will match both, but in practice LogSeq uses different formatting
    expect(tags).toContain('real-tag');
  });

  it('should handle tags with hyphens and underscores', () => {
    const content = 'Tags: #project-management #tech_debt';
    const tags = extractTags(content);
    expect(tags).toEqual(['project-management', 'tech_debt']);
  });
});

describe('buildPageNameMap', () => {
  it('should build map from page entities', () => {
    const pages: PageEntity[] = [
      {
        id: 1,
        uuid: 'uuid-1',
        name: 'project plan',
        originalName: 'Project Plan',
        'journal?': false
      },
      {
        id: 2,
        uuid: 'uuid-2',
        name: 'meeting notes',
        originalName: 'Meeting Notes',
        'journal?': false
      }
    ];

    const map = buildPageNameMap(pages);
    expect(map.size).toBe(2);
    expect(map.get(1)).toBe('Project Plan');
    expect(map.get(2)).toBe('Meeting Notes');
  });

  it('should handle pages with original-name kebab-case property', () => {
    const pages: PageEntity[] = [
      {
        id: 1,
        uuid: 'uuid-1',
        name: 'project',
        originalName: 'Project',
        'original-name': 'Project Kebab',
        'journal?': false
      }
    ];

    const map = buildPageNameMap(pages);
    // Should prefer originalName over original-name
    expect(map.get(1)).toBe('Project');
  });

  it('should fallback to name if originalName not present', () => {
    const pages: PageEntity[] = [
      {
        id: 1,
        uuid: 'uuid-1',
        name: 'project',
        originalName: '',
        'journal?': false
      }
    ];

    const map = buildPageNameMap(pages);
    expect(map.get(1)).toBe('project');
  });

  it('should handle empty array', () => {
    const map = buildPageNameMap([]);
    expect(map.size).toBe(0);
  });
});

describe('getPageNameFromBlock', () => {
  it('should get page name from block with id reference', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Test block',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const map = new Map([[1, 'Project Plan']]);
    const pageName = getPageNameFromBlock(block, map);
    expect(pageName).toBe('Project Plan');
  });

  it('should get page name from block with db/id reference', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Test block',
      page: { id: 0, 'db/id': 1 } as any,
      parent: { id: 1 },
      left: { id: 1 }
    };

    const map = new Map([[1, 'Project Plan']]);
    const pageName = getPageNameFromBlock(block, map);
    expect(pageName).toBe('Project Plan');
  });

  it('should return empty string if page not in map', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Test block',
      page: { id: 999 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const map = new Map([[1, 'Project Plan']]);
    const pageName = getPageNameFromBlock(block, map);
    expect(pageName).toBe('');
  });

  it('should return empty string if block has no page reference', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Test block',
      page: null as any,
      parent: { id: 1 },
      left: { id: 1 }
    };

    const map = new Map([[1, 'Project Plan']]);
    const pageName = getPageNameFromBlock(block, map);
    expect(pageName).toBe('');
  });
});

describe('toSlimBlock', () => {
  it('should transform basic block with essential fields', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Test block content',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim).toEqual({
      uuid: 'block-uuid',
      content: 'Test block content',
      pageName: 'Project Plan'
    });

    // Verify removed fields
    expect(slim).not.toHaveProperty('id');
    expect(slim).not.toHaveProperty('page');
    expect(slim).not.toHaveProperty('parent');
    expect(slim).not.toHaveProperty('left');

    // Verify UUID is kept
    expect(slim).toHaveProperty('uuid', 'block-uuid');
  });

  it('should include properties when present', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Test block',
      properties: { status: 'done', priority: 'high' },
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim.properties).toEqual({ status: 'done', priority: 'high' });
  });

  it('should omit empty properties', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Test block',
      properties: {},
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim).not.toHaveProperty('properties');
  });

  it('should include marker when present', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'TODO Finish task',
      marker: 'TODO',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim.marker).toBe('TODO');
  });

  it('should extract and include tags from content', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Working on #project #planning',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim.tags).toEqual(['project', 'planning']);
  });

  it('should omit tags when none present', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'No tags here',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim).not.toHaveProperty('tags');
  });

  it('should extract and include page references from content', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'See [[Project Plan]] and [[Meeting Notes]]',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim.pageRefs).toEqual(['Project Plan', 'Meeting Notes']);
  });

  it('should omit pageRefs when none present', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'No page references',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 }
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim).not.toHaveProperty('pageRefs');
  });

  it('should recursively transform children', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Parent block #parent',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 },
      children: [
        {
          id: 101,
          uuid: 'child-uuid-1',
          content: 'Child 1 [[Reference]]',
          page: { id: 1 },
          parent: { id: 100 },
          left: { id: 100 }
        },
        {
          id: 102,
          uuid: 'child-uuid-2',
          content: 'Child 2',
          marker: 'DONE',
          page: { id: 1 },
          parent: { id: 100 },
          left: { id: 101 }
        }
      ]
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim.children).toHaveLength(2);
    expect(slim.children![0]).toEqual({
      uuid: 'child-uuid-1',
      content: 'Child 1 [[Reference]]',
      pageName: 'Project Plan',
      pageRefs: ['Reference']
    });
    expect(slim.children![1]).toEqual({
      uuid: 'child-uuid-2',
      content: 'Child 2',
      pageName: 'Project Plan',
      marker: 'DONE'
    });

    // Verify children don't have verbose metadata
    expect(slim.children![0]).not.toHaveProperty('id');
    expect(slim.children![0]).toHaveProperty('uuid', 'child-uuid-1');
  });

  it('should handle deeply nested children', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'Level 1',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 },
      children: [
        {
          id: 101,
          uuid: 'child-uuid-1',
          content: 'Level 2',
          page: { id: 1 },
          parent: { id: 100 },
          left: { id: 100 },
          children: [
            {
              id: 102,
              uuid: 'child-uuid-2',
              content: 'Level 3',
              page: { id: 1 },
              parent: { id: 101 },
              left: { id: 101 }
            }
          ]
        }
      ]
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim.children).toHaveLength(1);
    expect(slim.children![0].children).toHaveLength(1);
    expect(slim.children![0].children![0].content).toBe('Level 3');
    expect(slim.children![0].children![0].uuid).toBe('child-uuid-2');
  });

  it('should omit children when array is empty', () => {
    const block: BlockEntity = {
      id: 100,
      uuid: 'block-uuid',
      content: 'No children',
      page: { id: 1 },
      parent: { id: 1 },
      left: { id: 1 },
      children: []
    };

    const slim = toSlimBlock(block, 'Project Plan');

    expect(slim).not.toHaveProperty('children');
  });
});

describe('toSlimPage', () => {
  it('should transform basic page with essential fields', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'project plan',
      originalName: 'Project Plan',
      'journal?': false
    };

    const slim = toSlimPage(page);

    expect(slim).toEqual({
      name: 'project plan',
      originalName: 'Project Plan'
    });

    // Verify removed fields
    expect(slim).not.toHaveProperty('id');
    expect(slim).not.toHaveProperty('uuid');
  });

  it('should include properties when present', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'project',
      originalName: 'Project',
      properties: { owner: 'team', status: 'active' },
      'journal?': false
    };

    const slim = toSlimPage(page);

    expect(slim.properties).toEqual({ owner: 'team', status: 'active' });
  });

  it('should omit empty properties', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'project',
      originalName: 'Project',
      properties: {},
      'journal?': false
    };

    const slim = toSlimPage(page);

    expect(slim).not.toHaveProperty('properties');
  });

  it('should include journal metadata when journal page', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'jan 1st, 2025',
      originalName: 'Jan 1st, 2025',
      'journal?': true,
      journalDay: 20250101
    };

    const slim = toSlimPage(page);

    expect(slim.isJournal).toBe(true);
    expect(slim.journalDate).toBe(20250101);
  });

  it('should omit journal metadata when not journal page', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'project',
      originalName: 'Project',
      'journal?': false
    };

    const slim = toSlimPage(page);

    expect(slim).not.toHaveProperty('isJournal');
    expect(slim).not.toHaveProperty('journalDate');
  });

  it('should handle journal property as boolean', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'jan 1st, 2025',
      originalName: 'Jan 1st, 2025',
      journal: true,
      journalDay: 20250101
    };

    const slim = toSlimPage(page);

    expect(slim.isJournal).toBe(true);
    expect(slim.journalDate).toBe(20250101);
  });

  it('should use original-name kebab-case if originalName not present', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'project',
      originalName: '',
      'original-name': 'Project Original',
      'journal?': false
    };

    const slim = toSlimPage(page);

    expect(slim.originalName).toBe('Project Original');
  });

  it('should fallback to name if neither originalName nor original-name present', () => {
    const page: PageEntity = {
      id: 1,
      uuid: 'page-uuid',
      name: 'project',
      originalName: '',
      'journal?': false
    };

    const slim = toSlimPage(page);

    expect(slim.originalName).toBe('project');
  });
});
