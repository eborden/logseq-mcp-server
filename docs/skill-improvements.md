# Proposed Improvements to Subagent-Driven Development Skill

## Summary
After implementing 4 comprehensive plans (13 tools, ~3,500 LOC), identified key improvements to reduce overhead while maintaining quality.

## Current Metrics
- **Success Rate**: 100% (all tasks completed successfully)
- **Code Quality**: High (all reviews passed, patterns consistent)
- **Test Coverage**: Comprehensive (unit + integration)
- **Overhead**: High (3 agents per complex task: implement → review → fix → review)

## Key Improvements

### 1. Adaptive Review Depth (High Priority)

**Current**: Full review after every task
**Proposed**: Match review depth to task complexity

```markdown
## Task Complexity Assessment

After subagent reports completion, classify task:

**TRIVIAL** - Skip review, just verify tests
- 1 file, <50 lines changed
- No logic changes (cleanup, formatting, docs)
- Examples: Remove unused variable, add comments, update README

**SIMPLE** - Quick review (2-3 min)
- 1-2 files, <100 lines total
- Single feature, follows existing patterns
- Review: Structure, tests pass, follows patterns
- Examples: Single tool with tests, simple enhancement

**COMPLEX** - Standard review (5-10 min)
- 3+ files or >100 lines
- Multiple features or novel patterns
- Review: Full architecture, test coverage, edge cases
- Examples: Multi-file feature, new patterns, refactoring

**CRITICAL** - Deep review + verification (10+ min)
- Security, auth, data loss risk
- Breaking API changes
- Performance-critical code
- Review: Security analysis, impact assessment, rollback plan
- Examples: Authentication, data migration, API changes
```

### 2. Batch Compatible Tasks (High Priority)

**Current**: Sequential execution, one task at a time
**Proposed**: Batch independent tasks

```markdown
## Task Batching Rules

Before dispatching subagent for Task N, check Task N+1:

**Can Batch If**:
- No shared files
- No sequential dependencies
- Both are simple complexity
- Combined LOC < 300

**Example Batches**:
- Integration tests + utility functions (different directories)
- Multiple independent tool implementations
- Documentation updates across different sections

**Implementation**:
Dispatch single subagent with:
"Implement Tasks N and N+1 from the plan. These are independent:
- Task N: [description]
- Task N+1: [description]

Complete both, run all tests, commit separately with proper messages."
```

### 3. Skip Re-Review for Minor Fixes (High Priority)

**Current**: Review → Fix → Review again
**Proposed**: Review → Fix → Continue (no re-review for suggestions)

```markdown
## Fix-Without-Review Criteria

Skip second review if:
- Previous review had ZERO Critical/Important issues
- Previous review had only "Suggestions" or "Nice to Have"
- Fix is <50 lines
- Fix doesn't change architecture
- Tests still pass

Apply fix via:
- Direct edit (if <10 lines)
- Single fix subagent (if 10-50 lines)
- Mark task complete immediately after tests pass

Re-review only if:
- Previous review flagged Critical/Important issues
- Fix touches files not in original implementation
- Fix changes approach/architecture
- Tests fail after fix
```

### 4. Plan Deviation Tracking (Medium Priority)

**Current**: Flag all deviations in reviews
**Proposed**: Track beneficial deviations separately

```markdown
## Deviation Handling

Maintain mental or written log of beneficial deviations:

**Don't Flag As Issues**:
- API differences (implementation more accurate than plan)
- Type improvements (better type safety)
- Performance optimizations (e.g., parallel API calls)
- Error handling enhancements

**Do Flag As Issues**:
- Missing required functionality
- Incorrect implementation
- Security problems
- Breaking changes

**During Review**:
Note beneficial deviations but classify as "BENEFICIAL DEVIATION" not "ISSUE".
```

### 5. Compact Progress Updates (Low Priority)

**Current**: Verbose summaries after each task
**Proposed**: Compact progress indicators

```markdown
## Progress Format

After each task completion:

✅ Task X/Y: [Tool Name] (Zmin)
   Tests: A+B passing | C skipped
   Files: +D/-E lines across F files
   Commit: [short-sha]

Only expand on:
- Issues requiring user attention
- Significant deviations
- Failed tests/builds
```

## Implementation Priority

### Phase 1: Immediate (Next Session)
1. Adaptive review depth
2. Skip re-review for suggestions
3. Batch compatible tasks

### Phase 2: Short Term (Next Week)
4. Plan deviation tracking
5. Compact progress updates

## Expected Impact

**Before Improvements**:
- 13 tasks × 3 agents avg = 39 subagent invocations
- ~10 min per task (implement + 2 reviews) = 130 min total
- High quality, high overhead

**After Improvements**:
- 13 tasks × 1.8 agents avg = 23 subagent invocations (-41%)
- ~6 min per task (implement + selective review) = 78 min total (-40%)
- Same quality, lower overhead

**Win Conditions**:
- Same test pass rate (100%)
- Same code quality (all patterns consistent)
- 40% reduction in time/tokens
- Better user experience (less waiting)

## Risks & Mitigations

**Risk**: Skipping reviews misses issues
**Mitigation**: Only skip for trivial/simple tasks with passing tests. Complex/critical tasks get full review.

**Risk**: Batching causes conflicts
**Mitigation**: Only batch truly independent tasks (different files, no shared dependencies).

**Risk**: Accumulated tech debt from suggestions
**Mitigation**: Track suggestions in backlog, address in dedicated refactoring tasks.

## Validation Plan

**Metrics to Track**:
- Task completion time
- Number of subagent invocations
- Review findings (Critical/Important/Suggestion ratio)
- Test pass rate
- Code quality (subjective, via final review)

**Success Criteria**:
- 30%+ reduction in subagent count
- Zero increase in Critical/Important review findings
- 100% test pass rate maintained
- Positive user feedback on speed

## Conclusion

The current subagent-driven development skill is **highly effective** for quality but has **optimization opportunities**. The proposed improvements maintain the quality bar while significantly reducing overhead through:
- Smart review depth adaptation
- Strategic task batching
- Eliminating redundant reviews

These changes preserve the core value (fresh context, TDD enforcement, quality gates) while removing waste (over-reviewing simple tasks, sequential execution of independent work).
